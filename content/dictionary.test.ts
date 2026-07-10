import { beforeEach, describe, expect, it } from "vitest";

import {
  buildMap,
  lookup,
  mergeOverlay,
  resetDictionary,
  setDictionary,
  type DictEntry,
} from "./dictionary";

function entry(
  t: string,
  p: string,
  d: string[],
): DictEntry {
  return { t, p, d };
}

describe("buildMap", () => {
  it("builds a Map from a plain entries object", () => {
    const m = buildMap({
      你好: [entry("你好", "nǐ hǎo", ["hello", "hi"])],
    });
    expect(m).toBeInstanceOf(Map);
    expect(m.get("你好")).toHaveLength(1);
  });

  it("returns an empty Map for an empty object", () => {
    expect(buildMap({}).size).toBe(0);
  });
});

describe("lookup", () => {
  const dict = buildMap({
    你好: [entry("你好", "nǐ hǎo", ["hello", "hi"])],
    汉字: [entry("漢字", "hàn zì", ["Chinese character"])],
  });

  it("returns entries for a known simplified word", () => {
    const result = lookup(dict, "你好");
    expect(result).not.toBeNull();
    expect(result![0].p).toBe("nǐ hǎo");
    expect(result![0].d).toContain("hello");
  });

  it("returns the traditional form and definitions from the stored entry", () => {
    const result = lookup(dict, "汉字");
    expect(result).not.toBeNull();
    expect(result![0].t).toBe("漢字");
    expect(result![0].d).toContain("Chinese character");
  });

  it("returns null for an unknown word (triggers fallback)", () => {
    expect(lookup(dict, "不存在")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(lookup(dict, "")).toBeNull();
  });

  it("returns null for a key whose entry array was emptied", () => {
    const m = new Map([["x", [] as DictEntry[]]]);
    expect(lookup(m, "x")).toBeNull();
  });
});

describe("mergeOverlay (M3.5 user-dict)", () => {
  const base = buildMap({
    你好: [entry("你好", "nǐ hǎo", ["hello"])],
    汉字: [entry("漢字", "hàn zì", ["Chinese character"])],
  });

  it("overrides base entries for matching keys", () => {
    const merged = mergeOverlay(base, {
      你好: [entry("你好", "nǐ hǎo", ["custom hello from user dict"])],
    });
    const result = lookup(merged, "你好");
    expect(result![0].d).toEqual(["custom hello from user dict"]);
    // Non-overridden key survives.
    expect(lookup(merged, "汉字")![0].d).toContain("Chinese character");
  });

  it("adds new keys that exist only in the overlay", () => {
    const merged = mergeOverlay(base, {
      功法: [entry("功法", "gōng fǎ", ["cultivation technique"])],
    });
    const result = lookup(merged, "功法");
    expect(result).not.toBeNull();
    expect(result![0].d).toContain("cultivation technique");
  });

  it("does not mutate the base map", () => {
    const before = base.get("你好");
    mergeOverlay(base, {
      你好: [entry("你好", "nǐ hǎo", ["changed"])],
    });
    expect(base.get("你好")).toBe(before);
    expect(base.get("你好")![0].d).toEqual(["hello"]);
  });
});

describe("setDictionary / resetDictionary", () => {
  beforeEach(() => {
    resetDictionary();
  });

  it("setDictionary injects a map usable by lookup via the module singleton", async () => {
    const m = buildMap({
      测试: [entry("測試", "cè shì", ["test"])],
    });
    setDictionary(m);
    // After setDictionary, loadDictionary should return the injected map
    // without any fetch.
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    expect(lookup(dict, "测试")![0].d).toContain("test");
  });

  it("resetDictionary clears the singleton so the next load fetches fresh", async () => {
    setDictionary(buildMap({ 旧: [entry("舊", "jiù", ["old"])] }));
    resetDictionary();
    const { loadDictionary } = await import("./dictionary");
    // loadDictionary will try to fetch (no chrome.runtime in jsdom) — should
    // reject. We assert the singleton is unset rather than the fetch path.
    await expect(loadDictionary()).rejects.toThrow();
  });
});
