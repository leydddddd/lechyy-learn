import { describe, expect, it } from "vitest";
import type { CollectedBlock } from "./segmenter";
import { extractArticle } from "./sentence";

function block(text: string): CollectedBlock {
  return { element: document.createElement("p"), text };
}

describe("extractArticle", () => {
  it("returns empty array for empty blocks", () => {
    expect(extractArticle([])).toEqual([]);
  });

  it("returns empty array when all blocks are empty/whitespace", () => {
    const blocks = [block("   "), block("\n\n")];
    expect(extractArticle(blocks)).toEqual([]);
  });

  it("picks the densest cluster from mixed content", () => {
    const blocks = [
      block("导航栏"),                  // index 0 — sparse preamble
      block(""), block(""), block(""), block(""), // indices 1-4 — gap
      block("第一段正文。这是正文内容。"), // index 5 — dense cluster starts
      block("第二段也是正文。"),          // index 6
      block("第三段正文内容在这里。"),     // index 7
      block(""), block(""), block(""),   // indices 8-10 — gap
      block("页脚信息。"),                // index 11 — sparse footer
    ];
    const sentences = extractArticle(blocks);
    expect(sentences.length).toBeGreaterThan(0);
    // All sentences should come from the dense cluster (indices 5-7)
    for (const s of sentences) {
      expect(s.blockIndex).toBeGreaterThanOrEqual(5);
      expect(s.blockIndex).toBeLessThanOrEqual(7);
    }
    const allText = sentences.map((s) => s.text).join("");
    expect(allText).toContain("第一段正文");
    expect(allText).toContain("第二段也是正文。");
    expect(allText).toContain("第三段正文");
  });

  it("splits a multi-sentence block into separate Sentence objects", () => {
    const blocks = [
      block("第一句。第二句！第三句？"),
      block("第四句；第五句。"),
    ];
    const sentences = extractArticle(blocks);
    expect(sentences.length).toBe(5);
    expect(sentences[0].text).toBe("第一句。");
    expect(sentences[0].blockIndex).toBe(0);
    expect(sentences[0].startOffset).toBe(0);
    expect(sentences[0].endOffset).toBe(4);
    expect(sentences[1].text).toBe("第二句！");
    expect(sentences[1].blockIndex).toBe(0);
    expect(sentences[2].text).toBe("第三句？");
    expect(sentences[2].blockIndex).toBe(0);
    expect(sentences[3].text).toBe("第四句；");
    expect(sentences[3].blockIndex).toBe(1);
    expect(sentences[4].text).toBe("第五句。");
    expect(sentences[4].blockIndex).toBe(1);
  });

  it("does not split inside paired brackets/quotes", () => {
    const blocks = [
      block("他说（这是重要内容。）然后继续。后面还有。"),
    ];
    const sentences = extractArticle(blocks);
    expect(sentences.length).toBe(2);
    expect(sentences[0].text).toBe("他说（这是重要内容。）然后继续。");
    expect(sentences[1].text).toBe("后面还有。");
  });

  it("splits on newlines within a block", () => {
    const blocks = [
      block("第一句。\n第二句。"),
    ];
    const sentences = extractArticle(blocks);
    expect(sentences.length).toBe(2);
    expect(sentences[0].text).toBe("第一句。");
    expect(sentences[1].text).toBe("第二句。");
  });

  it("preserves provenance offsets correctly after quote-balanced split", () => {
    const blocks = [
      block("「你好吗？」他问。"),
    ];
    const sentences = extractArticle(blocks);
    expect(sentences.length).toBe(1);
    expect(sentences[0].text).toBe("「你好吗？」他问。");
    expect(sentences[0].startOffset).toBe(0);
    expect(sentences[0].endOffset).toBe(9);
  });

  it("handles single block with no sentence-ending punctuation", () => {
    const blocks = [block("这是一个没有标点的段落")];
    const sentences = extractArticle(blocks);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].text).toBe("这是一个没有标点的段落");
    expect(sentences[0].blockIndex).toBe(0);
    expect(sentences[0].startOffset).toBe(0);
    expect(sentences[0].endOffset).toBe(11);
  });

  it("skips blank blocks within cluster", () => {
    const blocks = [
      block("第一段。"),
      block(""),
      block("第二段。"),
    ];
    const sentences = extractArticle(blocks);
    // The empty block should not produce a sentence, but the cluster should
    // include blocks 0, 1, 2 due to gap threshold.
    expect(sentences.length).toBe(2);
    expect(sentences[0].blockIndex).toBe(0);
    expect(sentences[1].blockIndex).toBe(2);
  });

  it("whole article in one block with mixed punctuation", () => {
    const blocks = [block("你好。今天天气不错！我们出发吧？等等；还有一件事。")];
    const sentences = extractArticle(blocks);
    expect(sentences).toHaveLength(5);
    expect(sentences.map((s) => s.text)).toEqual([
      "你好。",
      "今天天气不错！",
      "我们出发吧？",
      "等等；",
      "还有一件事。",
    ]);
  });

  it("clusters: three-adjacent paragraph gap resets the cluster", () => {
    // Gap threshold = 3: if blockIndex gap > 3, start a new cluster.
    // We need a cluster of 1 block, then a gap of 4+ empty blocks, then a cluster of 1 block.
    // The larger cluster wins.
    const blocks = [
      block("第一段正文。"),
      block(""), block(""), block(""), block(""),
      block("第二段正文。"),
    ];
    const sentences = extractArticle(blocks);
    // Both clusters have size 1; later cluster wins via tiebreaker.
    expect(sentences.length).toBe(1);
    expect(sentences[0].text).toContain("第二段");
  });
});