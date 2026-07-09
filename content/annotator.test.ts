import { beforeEach, describe, expect, it } from "vitest";
import {
  ANNOTATED_ATTR,
  collectTextNodes,
  containsHanzi,
  SKIP_TAGS,
} from "./segmenter";
import { annotateText, annotateTextNode, initAnnotator } from "./annotator";

function setBody(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("collectTextNodes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns nothing for a body with no CJK", () => {
    setBody("<p>Hello world 123 — no Chinese here.</p>");
    expect(collectTextNodes(document.body)).toHaveLength(0);
  });

  it("collects text nodes containing hanzi", () => {
    setBody('<p>汉字 <span>pure latin inner</span> 第二句。</p>');
    const nodes = collectTextNodes(document.body);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.text)).toEqual(
      expect.arrayContaining(["汉字 ", " 第二句。"]),
    );
  });

  it("skips subtrees under SKIP_TAGS (script, style, code, pre, ruby)", () => {
    setBody(`
      <p>外面有汉字</p>
      <script>var x = "汉字不应被收集";</script>
      <style>.x::before { content: "汉字也不应" }</style>
      <pre>预格式化汉字</pre>
      <code>代码汉字</code>
      <ruby data-word="测试"><rb>测试</rb><rt>cèshì</rt></ruby>
    `);
    const nodes = collectTextNodes(document.body);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("外面有汉字");
  });

  it("does not descend into already-annotated parents", () => {
    setBody(`
      <p>普通文本汉字</p>
      <div ${ANNOTATED_ATTR}="1">已标注汉字不应再处理</div>
    `);
    const nodes = collectTextNodes(document.body);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("普通文本汉字");
  });

  it("has ruby in the skip set", () => {
    expect(SKIP_TAGS.has("RUBY")).toBe(true);
    expect(SKIP_TAGS.has("SCRIPT")).toBe(true);
  });
});

describe("annotateText", () => {
  it("initAnnotator is idempotent", () => {
    initAnnotator();
    initAnnotator();
  });

  it("wraps multi-char hanzi words into a single ruby with multiple rb/rt pairs", () => {
    const frag = annotateText("他睡着了。");
    const rubies = Array.from(frag.querySelectorAll("ruby[data-word]"));
    expect(rubies.length).toBeGreaterThan(0);
    // Find the "睡着" token (2-char word): one ruby, two rb, two rt.
    const shuizhao = rubies.find((r) => r.getAttribute("data-word") === "睡着");
    expect(shuizhao).toBeDefined();
    expect(shuizhao!.querySelectorAll("rb")).toHaveLength(2);
    expect(shuizhao!.querySelectorAll("rt")).toHaveLength(2);
    const rts = Array.from(shuizhao!.querySelectorAll("rt")).map((r) => r.textContent);
    expect(rts).toEqual(["shuì", "zháo"]); // polyphone: 着 = zháo here
  });

  it("emits non-CJK tokens as plain text nodes (no ruby)", () => {
    const frag = annotateText("Web 小说 reading");
    const rubies = Array.from(frag.querySelectorAll("ruby[data-word]"));
    // Only "小说" (and any 中文 sub-tokens) get ruby; "Web"/"reading" don't.
    const nonHanziText = Array.from(frag.childNodes)
      .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join("");
    expect(nonHanziText).toContain("Web");
    expect(nonHanziText).toContain("reading");
    // At least one ruby should exist (the 小说 part).
    expect(rubies.length).toBeGreaterThan(0);
  });

  it("passes CJK punctuation through as plain text, never as ruby", () => {
    const frag = annotateText("汉字，汉字。");
    const rubies = Array.from(frag.querySelectorAll("ruby[data-word]"));
    for (const r of rubies) {
      const w = r.getAttribute("data-word") ?? "";
      // data-word on a ruby must contain at least one actual hanzi, never
      // standalone punctuation.
      expect(containsHanzi(w)).toBe(true);
    }
  });

  it("tags each rt with a tone-N class matching its pinyin", () => {
    const frag = annotateText("汉字");
    const rts = Array.from(frag.querySelectorAll("rt"));
    for (const rt of rts) {
      const cls = rt.className;
      expect(cls).toMatch(/^tone-[1-4]$/);
    }
  });

  it("stores original text in data-hanzi-source for future revert", () => {
    const frag = annotateText("汉字");
    const ruby = frag.querySelector("ruby[data-word]")!;
    expect(ruby.getAttribute("data-hanzi-source")).toBeTruthy();
  });
});

describe("annotateTextNode", () => {
  it("replaces the text node with a ruby fragment and marks the parent", () => {
    setBody('<p id="p">他睡着了。</p>');
    const p = document.getElementById("p")!;
    const textNode = p.firstChild as Text;
    expect(textNode.nodeType).toBe(Node.TEXT_NODE);
    const inserted = annotateTextNode(textNode);
    expect(inserted.length).toBeGreaterThan(0);
    // Parent is now marked annotated.
    expect(p.hasAttribute(ANNOTATED_ATTR)).toBe(true);
    // Text node is gone, ruby inserted in its place.
    expect(p.querySelector("ruby[data-word]")).not.toBeNull();
    // Text node detached.
    expect(textNode.parentNode).toBeNull();
  });

  it("returns [] when the node has no parent (already removed)", () => {
    const orphan = document.createTextNode("孤立汉字");
    expect(annotateTextNode(orphan)).toEqual([]);
  });
});
