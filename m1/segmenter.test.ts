import { describe, expect, it } from "vitest";
import { containsHanzi, toneClass } from "../content/segmenter";

describe("toneClass", () => {
  it("returns tone-4 for falling tone", () => {
    expect(toneClass("hàn")).toBe("tone-4");
    expect(toneClass("zì")).toBe("tone-4");
  });

  it("returns tone-2 for rising tone", () => {
    expect(toneClass("bú")).toBe("tone-2");
    expect(toneClass("ér")).toBe("tone-2");
  });

  it("returns tone-3 for dipping tone", () => {
    expect(toneClass("mǔ")).toBe("tone-3");
    expect(toneClass("biǎo")).toBe("tone-3");
  });

  it("returns tone-1 for first/macron tone", () => {
    expect(toneClass("mā")).toBe("tone-1");
    expect(toneClass("shēng")).toBe("tone-1");
  });

  it("returns tone-1 as fallback for neutral tone", () => {
    expect(toneClass("de")).toBe("tone-1");
    expect(toneClass("le")).toBe("tone-1");
  });

  it("handles v-umlaut tones", () => {
    expect(toneClass("nǚ")).toBe("tone-3");
    expect(toneClass("lǜ")).toBe("tone-4");
  });
});

describe("containsHanzi", () => {
  it("true for CJK Unified Ideographs", () => {
    expect(containsHanzi("汉字")).toBe(true);
    expect(containsHanzi("Web 小说")).toBe(true);
  });

  it("false for pure ASCII / Latin / punctuation", () => {
    expect(containsHanzi("Web novel")).toBe(false);
    expect(containsHanzi("123 — !?")).toBe(false);
    expect(containsHanzi("")).toBe(false);
  });

  it("false for CJK punctuation only (ideographic comma etc.)", () => {
    expect(containsHanzi("，。！？")).toBe(false);
    expect(containsHanzi("—— 「」")).toBe(false);
  });
});
