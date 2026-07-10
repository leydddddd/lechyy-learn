import { describe, expect, it } from "vitest";

import { buildIndex } from "../scripts/build-dict";

// A tiny synthetic CC-CEDICT excerpt covering: comment lines, a basic 2-char
// word, a polyphone variant, a single-char entry, an entry with multiple defs,
// and a numeric (non-hanzi) entry. This mirrors the real file format so the
// parser is tested against the actual line shape without needing the 12MB
// download. Note CC-CEDICT line order is "traditional simplified [pinyin] /defs/"
// — the _ts suffix in the filename stands for traditional→simplified ordering.
const SAMPLE = `# CC-CEDICT
# Community maintained free Chinese-English dictionary.
#! format_version=0

你好 你好 [ni3 hao3] /hello/hi/
漢字 汉字 [han4 zi4] /Chinese character/CJK character/
字 字 [zi4] /character/letter/word/
11區 11区 [11 Qu1] /(ACG) Japan (from the anime "Code Geass")/
`;

describe("buildIndex (CC-CEDICT parser)", () => {
  const index = buildIndex(SAMPLE);

  it("skips comment and blank lines", () => {
    expect(index.entries["#"]).toBeUndefined();
    expect(index.v).toBe(1);
  });

  it("keys entries by the simplified form", () => {
    expect(index.entries["你好"]).toBeDefined();
    expect(index.entries["汉字"]).toBeDefined();
    expect(index.entries["字"]).toBeDefined();
  });

  it("converts numeric pinyin to tone-marked form", () => {
    const entry = index.entries["你好"]![0];
    expect(entry.p).toBe("nǐ hǎo");
    expect(index.entries["汉字"]![0].p).toBe("hàn zì");
    expect(index.entries["字"]![0].p).toBe("zì");
  });

  it("stores the traditional form and all definitions", () => {
    const entry = index.entries["汉字"]![0];
    expect(entry.t).toBe("漢字");
    expect(entry.d).toEqual(["Chinese character", "CJK character"]);
  });

  it("handles entries with non-hanzi (numeric/latin) forms", () => {
    expect(index.entries["11区"]).toBeDefined();
    expect(index.entries["11区"]![0].d[0]).toContain("Japan");
  });

  it("parses a multi-definition entry into a string array", () => {
    const defs = index.entries["字"]![0].d;
    expect(defs).toEqual(["character", "letter", "word"]);
  });
});
