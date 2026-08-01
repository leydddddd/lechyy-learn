import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  collectTextNodes,
  containsHanzi,
  SKIP_TAGS,
} from "./segmenter";
import {
  annotateText,
  annotateTextNode,
  applyCustomSegments,
  ensureAnnotator,
} from "./annotator";

function setBody(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

// Dictionary loaded once in beforeAll. No per-test module resets to avoid
// leaking ~10 MB of pinyin-pro data in jsdom/Vitest's module map.
beforeAll(async () => {
  await ensureAnnotator();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

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

  it("does not re-collect text inside ruby elements (SKIP_TAGS)", () => {
    setBody(`
      <p>普通文本汉字</p>
      <ruby data-word="已标注"><rb>已标注</rb><rt>yǐ biāo zhù</rt></ruby>
    `);
    const nodes = collectTextNodes(document.body);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("普通文本汉字");
  });

  it("multiple text nodes in same parent are all collected", () => {
    setBody('<p>汉字<b>汉字</b>汉字</p>');
    const nodes = collectTextNodes(document.body);
    expect(nodes).toHaveLength(3);
  });

  it("has ruby in the skip set", () => {
    expect(SKIP_TAGS.has("RUBY")).toBe(true);
    expect(SKIP_TAGS.has("SCRIPT")).toBe(true);
  });

  it("excludes text inside <div contenteditable>", () => {
    setBody('<div contenteditable="true">汉字编辑中</div>');
    expect(collectTextNodes(document.body)).toHaveLength(0);
  });

  it("excludes text inside [aria-hidden=\"true\"]", () => {
    setBody('<div aria-hidden="true">汉字隐藏</div>');
    expect(collectTextNodes(document.body)).toHaveLength(0);
  });

  it("excludes text inside [inert]", () => {
    setBody('<div inert>汉字惰性</div>');
    expect(collectTextNodes(document.body)).toHaveLength(0);
  });

  it("nested text inside contenteditable element is rejected via parent walk", () => {
    setBody('<div contenteditable><p><span>汉字深层嵌套</span></p></div>');
    const div = document.querySelector("div")!;
    // Verify the ancestor is an editing surface (contenteditable attr present)
    expect(div.hasAttribute("contenteditable")).toBe(true);
    expect(collectTextNodes(document.body)).toHaveLength(0);
  });
});

describe("ensureAnnotator", () => {
  it("returns same promise on concurrent calls (idempotent)", async () => {
    const p1 = ensureAnnotator();
    const p2 = ensureAnnotator();
    expect(p1).toBe(p2);
    await p1;
    const p3 = ensureAnnotator();
    expect(p3).toBe(p1);
  });
});

describe("annotateText", () => {
  it("wraps multi-char hanzi words into a single ruby with multiple rb/rt pairs", async () => {
    const frag = await annotateText("他睡着了。");
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

  it("emits non-CJK tokens as plain text nodes (no ruby)", async () => {
    const frag = await annotateText("Web 小说 reading");
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

  it("passes CJK punctuation through as plain text, never as ruby", async () => {
    const frag = await annotateText("汉字，汉字。");
    const rubies = Array.from(frag.querySelectorAll("ruby[data-word]"));
    for (const r of rubies) {
      const w = r.getAttribute("data-word") ?? "";
      // data-word on a ruby must contain at least one actual hanzi, never
      // standalone punctuation.
      expect(containsHanzi(w)).toBe(true);
    }
  });

  it("tags each rt with a tone-N class matching its pinyin", async () => {
    const frag = await annotateText("汉字");
    const rts = Array.from(frag.querySelectorAll("rt"));
    for (const rt of rts) {
      const cls = rt.className;
      expect(cls).toMatch(/^tone-[1-4]$/);
    }
  });

  it("stores original text in data-hanzi-source for future revert", async () => {
    const frag = await annotateText("汉字");
    const ruby = frag.querySelector("ruby[data-word]")!;
    expect(ruby.getAttribute("data-hanzi-source")).toBeTruthy();
  });
});

describe("applyCustomSegments (M3.5 pre-segmentation)", () => {
  it("no terms → each character is a separate segment", () => {
    expect(applyCustomSegments("汉字", [])).toEqual(["汉", "字"]);
  });

  it("longest-match greedy: 青云宗 matches before 青云 or single chars", () => {
    const terms = ["青云宗", "青云"];
    expect(applyCustomSegments("青云宗", terms)).toEqual(["青云宗"]);
  });

  it("custom term at start of text", () => {
    const terms = ["功法"];
    expect(applyCustomSegments("功法入门", terms)).toEqual(["功法", "入", "门"]);
  });

  it("custom term in middle, chars before and after", () => {
    const terms = ["功法"];
    expect(applyCustomSegments("练功法入门", terms)).toEqual(["练", "功法", "入", "门"]);
  });

  it("custom term at end of text", () => {
    const terms = ["青云宗"];
    expect(applyCustomSegments("加入青云宗", terms)).toEqual(["加", "入", "青云宗"]);
  });

  it("multiple custom terms in one string", () => {
    const terms = ["青云宗", "功法"];
    expect(applyCustomSegments("功法在青云宗", terms)).toEqual(["功法", "在", "青云宗"]);
  });

  it("non-CJK characters always emit as single segments", () => {
    const terms = ["功法"];
    expect(applyCustomSegments("功法ABC123", terms)).toEqual(["功法", "A", "B", "C", "1", "2", "3"]);
  });

  it("Chinese punctuation (outside CJK range) emits as single segments", () => {
    const terms = ["你好"];
    expect(applyCustomSegments("你好，世界。", terms)).toEqual(["你好", "，", "世", "界", "。"]);
  });

  it("longest-match wins over prefix/substring overlap", () => {
    const terms = ["青云宗外门", "青云宗", "青云"];
    expect(applyCustomSegments("青云宗外门", terms)).toEqual(["青云宗外门"]);
    expect(applyCustomSegments("青云宗门", terms)).toEqual(["青云宗", "门"]);
  });

  it("preserves text that has no match against any term", () => {
    const terms = ["功法"];
    expect(applyCustomSegments("无关联文字", terms)).toEqual(["无", "关", "联", "文", "字"]);
  });

  it("empty text returns empty array", () => {
    expect(applyCustomSegments("", [])).toEqual([]);
    expect(applyCustomSegments("", ["功法"])).toEqual([]);
  });

  it("term list sorted longest-first works with given order (caller responsibility)", () => {
    // getCustomTerms() already provides longest-first. Verify that if terms
    // are correctly sorted, greedy produces correct results.
    const terms = ["修真界", "修真", "真"];
    expect(applyCustomSegments("修真界修真真", terms)).toEqual(["修真界", "修真", "真"]);
  });
});

describe("annotateText with customTerms (M3.5)", () => {
  it("custom term produces a single ruby element with all chars inside", async () => {
    const terms = ["青云宗"];
    const frag = await annotateText("青云宗", terms);
    const rubies = Array.from(frag.querySelectorAll("ruby[data-word]"));
    expect(rubies).toHaveLength(1);
    expect(rubies[0].getAttribute("data-word")).toBe("青云宗");
    expect(rubies[0].querySelectorAll("rb")).toHaveLength(3);
    expect(rubies[0].querySelectorAll("rt")).toHaveLength(3);
  });

  it("custom term + surrounding non-custom text both annotated", async () => {
    const terms = ["功法"];
    const frag = await annotateText("练功法入门", terms);
    const rubies = Array.from(frag.querySelectorAll("ruby[data-word]"));
    // 练, 功法, 入, 门 → pinyin-pro may combine 入门; check at least 功法 is present
    const gongfa = rubies.find((r) => r.getAttribute("data-word") === "功法");
    expect(gongfa).toBeDefined();
    expect(gongfa!.querySelectorAll("rb")).toHaveLength(2);
  });

  it("no custom terms (or empty) produces same result as original annotateText", async () => {
    const frag1 = await annotateText("汉字，汉字。");
    const frag2 = await annotateText("汉字，汉字。", []);
    const rubies1 = Array.from(frag1.querySelectorAll("ruby[data-word]"));
    const rubies2 = Array.from(frag2.querySelectorAll("ruby[data-word]"));
    expect(rubies1.length).toBe(rubies2.length);
    expect(rubies1.map((r) => r.getAttribute("data-word"))).toEqual(
      rubies2.map((r) => r.getAttribute("data-word")),
    );
  });

  it("muscle test: full sentence with custom terms in hanzi stream", async () => {
    const terms = ["青云宗", "功法", "筑基丹"];
    const text = "青云宗主修炼功法依靠筑基丹突破境界。";
    const frag = await annotateText(text, terms);
    const rubies = Array.from(frag.querySelectorAll("ruby[data-word]"));
    // 青云宗, 主, 修炼, 功法, 依靠, 筑基丹, 突破, 境界, 。
    const words = rubies.map((r) => r.getAttribute("data-word"));
    expect(words).toContain("青云宗");
    expect(words).toContain("功法");
    expect(words).toContain("筑基丹");
    // Verify custom terms have full char count
    for (const term of ["青云宗", "功法", "筑基丹"]) {
      const rbCount = rubies.find((r) => r.getAttribute("data-word") === term)!.querySelectorAll("rb").length;
      expect(rbCount).toBe(term.length);
    }
  });
});

describe("annotateTextNode", () => {
  it("replaces the text node with a ruby fragment", async () => {
    setBody('<p id="p">他睡着了。</p>');
    const p = document.getElementById("p")!;
    const textNode = p.firstChild as Text;
    expect(textNode.nodeType).toBe(Node.TEXT_NODE);
    const inserted = await annotateTextNode(textNode);
    expect(inserted.length).toBeGreaterThan(0);
    // Text node is gone, ruby inserted in its place.
    expect(p.querySelector("ruby[data-word]")).not.toBeNull();
    // Text node detached.
    expect(textNode.parentNode).toBeNull();
  });

  it("returns [] when the node has no parent (already removed)", async () => {
    const orphan = document.createTextNode("孤立汉字");
    expect(await annotateTextNode(orphan)).toEqual([]);
  });
});
