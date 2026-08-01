import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildMap,
  getCustomTerms,
  getUserDictEntries,
  lookup,
  mergeOverlay,
  resetDictionary,
  setDictionary,
  setLruSize,
  setUserEntry,
  ShardedDictionary,
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

describe("getUserDictEntries / setUserEntry (chrome.storage M3.5)", () => {
  const storageState: Record<string, unknown> = {};

  function mockStorage(): void {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockImplementation(
            async (keys: string | string[] | Record<string, unknown>) => {
              if (typeof keys === "string") {
                return { [keys]: storageState[keys] };
              }
              if (Array.isArray(keys)) {
                const out: Record<string, unknown> = {};
                for (const k of keys) out[k] = storageState[k];
                return out;
              }
              return { ...storageState };
            },
          ),
          set: vi.fn().mockImplementation(
            async (items: Record<string, unknown>) => {
              Object.assign(storageState, items);
            },
          ),
          remove: vi.fn(),
          clear: vi.fn(),
        },
      },
    } as unknown as typeof chrome);
  }

  function clearStorageMock(): void {
    for (const k of Object.keys(storageState)) delete storageState[k];
    vi.unstubAllGlobals();
  }

  beforeEach(() => {
    clearStorageMock();
    mockStorage();
  });

  afterEach(() => {
    clearStorageMock();
  });

  it("returns null when storage is empty", async () => {
    const result = await getUserDictEntries();
    expect(result).toBeNull();
  });

  it("returns null when chrome is absent", async () => {
    vi.unstubAllGlobals();
    const result = await getUserDictEntries();
    expect(result).toBeNull();
  });

  it("returns stored entries as a Record after setUserEntry", async () => {
    await setUserEntry("功法", entry("功法", "gōng fǎ", ["cultivation technique"]));
    const result = await getUserDictEntries();
    expect(result).not.toBeNull();
    expect(result!["功法"]).toHaveLength(1);
    expect(result!["功法"][0].d).toContain("cultivation technique");
  });

  it("preserves existing keys when adding a new entry", async () => {
    await setUserEntry("功法", entry("功法", "gōng fǎ", ["cultivation technique"]));
    await setUserEntry("青云宗", entry("青雲宗", "qīng yún zōng", ["Azure Cloud Sect"]));
    const result = await getUserDictEntries();
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toHaveLength(2);
    expect(result!["功法"]).toBeDefined();
    expect(result!["青云宗"]).toBeDefined();
  });

  it("overwrites an entry for a key that already exists", async () => {
    await setUserEntry("功法", entry("功法", "gōng fǎ", ["cultivation technique"]));
    await setUserEntry("功法", entry("功法", "gōng fǎ", ["improved definition"]));
    const result = await getUserDictEntries();
    expect(result!["功法"][0].d).toEqual(["improved definition"]);
  });

  it("is a silent no-op when chrome is absent (no throw)", async () => {
    vi.unstubAllGlobals();
    await expect(
      setUserEntry("x", entry("x", "y", ["z"])),
    ).resolves.toBeUndefined();
  });
});

describe("getCustomTerms (M3.5 segmentation list)", () => {
  function mockStorage(entries: Record<string, DictEntry[]>): void {
    Object.assign(globalThis as Record<string, unknown>, {
      chrome: {
        storage: {
          local: {
            get: vi.fn().mockImplementation(
              async (_keys: string | string[] | Record<string, unknown>) => ({ userDict: entries }),
            ),
            set: vi.fn(),
            remove: vi.fn(),
            clear: vi.fn(),
          },
        },
      },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty array when storage is empty", async () => {
    mockStorage({});
    expect(await getCustomTerms()).toEqual([]);
  });

  it("returns sorted terms: longest first", async () => {
    mockStorage({
      我: [{ t: "我", p: "wǒ", d: ["I"] }],
      青云: [{ t: "青雲", p: "qīng yún", d: ["azure clouds"] }],
      青云宗: [{ t: "青雲宗", p: "qīng yún zōng", d: ["Azure Cloud Sect"] }],
    });
    expect(await getCustomTerms()).toEqual(["青云宗", "青云", "我"]);
  });

  it("breaks length ties with localeCompare", async () => {
    mockStorage({
      能人: [{ t: "能人", p: "néng rén", d: ["capable person"] }],
      病人: [{ t: "病人", p: "bìng rén", d: ["patient"] }],
    });
    const terms = await getCustomTerms();
    expect(terms).toHaveLength(2);
    // Both are 2-char; localeCompare dictates order.
    expect(terms[0].length).toBe(2);
    expect(terms[1].length).toBe(2);
    expect(terms[0].localeCompare(terms[1], "zh-Hans-CN") < 0).toBe(true);
  });
});

describe("storage precedence in loadDictionary (M3.5)", () => {
  const storageState: Record<string, unknown> = {};

  function mockStorageAndFetch(
    userEntries: Record<string, DictEntry[]> | null,
    seedEntries: Record<string, DictEntry[]> | null,
    cedictEntries: Record<string, DictEntry[]>,
  ): void {
    // mock chrome.storage.local
    if (userEntries) storageState.userDict = userEntries;
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockImplementation(
            async (_keys: string | string[] | Record<string, unknown>) => {
              if (storageState.userDict) return { userDict: storageState.userDict };
              return {};
            },
          ),
          set: vi.fn(),
          remove: vi.fn(),
          clear: vi.fn(),
        },
      },
    } as unknown as typeof chrome);

    // mock fetch: CEDICT first, then user-dict seed
    let fetchSeq = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: string) => {
        fetchSeq++;
        if (fetchSeq === 1) {
          // CEDICT
          return {
            ok: true,
            json: async () => ({ v: 1, entries: cedictEntries }),
          };
        }
        // user-dict.json seed
        if (seedEntries) {
          return { ok: true, json: async () => seedEntries };
        }
        return { ok: false, status: 404 };
      },
    ));
  }

  beforeEach(() => {
    resetDictionary();
    clearStorageMock();
  });

  afterEach(() => {
    resetDictionary();
    clearStorageMock();
  });

  function clearStorageMock(): void {
    for (const k of Object.keys(storageState)) delete storageState[k];
    vi.unstubAllGlobals();
  }

  const cedictBase: Record<string, DictEntry[]> = {
    你好: [{ t: "你好", p: "nǐ hǎo", d: ["hello"] }],
    汉字: [{ t: "漢字", p: "hàn zì", d: ["Chinese character"] }],
  };

  it("returns CEDICT-only when no user entries exist", async () => {
    mockStorageAndFetch(null, null, cedictBase);
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    const result = lookup(dict, "你好");
    expect(result!).not.toBeNull();
    expect(result![0].d).toContain("hello");
    expect(lookup(dict, "功法")).toBeNull(); // no user dict
  });

  it("storage user entry overrides CEDICT for the same key", async () => {
    const userEntries = {
      你好: [{ t: "你好", p: "nǐ hǎo", d: ["custom hello from storage"] }],
    };
    mockStorageAndFetch(userEntries, null, cedictBase);
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    const result = lookup(dict, "你好");
    expect(result![0].d).toEqual(["custom hello from storage"]);
  });

  it("storage user entry adds new key not in CEDICT", async () => {
    const userEntries = {
      功法: [{ t: "功法", p: "gōng fǎ", d: ["cultivation technique"] }],
    };
    mockStorageAndFetch(userEntries, null, cedictBase);
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    const result = lookup(dict, "功法");
    expect(result).not.toBeNull();
    expect(result![0].d).toContain("cultivation technique");
  });

  it("storage wins over seed file for same key", async () => {
    const userEntries = {
      法器: [{ t: "法器", p: "fǎ qì", d: ["storage definition for 法器"] }],
    };
    const seedEntries = {
      法器: [{ t: "法器", p: "fǎ qì", d: ["seed file definition (should lose)"] }],
    };
    mockStorageAndFetch(userEntries, seedEntries, cedictBase);
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    const result = lookup(dict, "法器");
    expect(result![0].d).toEqual(["storage definition for 法器"]);
  });

  it("seed file adds new key when storage has no conflicting entry", async () => {
    const userEntries = {
      功法: [{ t: "功法", p: "gōng fǎ", d: ["cultivation technique"] }],
    };
    const seedEntries = {
      宗门: [{ t: "宗門", p: "zōng mén", d: ["sect"] }],
    };
    mockStorageAndFetch(userEntries, seedEntries, cedictBase);
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    expect(lookup(dict, "功法")![0].d).toContain("cultivation technique");
    expect(lookup(dict, "宗门")![0].d).toContain("sect");
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

describe("placeholder data contract (M0.1)", () => {
  beforeEach(() => {
    resetDictionary();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    resetDictionary();
    vi.unstubAllGlobals();
  });

  it("emits [lechyy] console.warn and still loads entries when placeholder is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        v: 0,
        _placeholder: true,
        entries: { 你好: [{ t: "你好", p: "nǐ hǎo", d: ["placeholder"] }] },
      }),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    const result = lookup(dict, "你好");
    expect(result).not.toBeNull();
    expect(result![0].d).toEqual(["placeholder"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("[lechyy]");
    expect(warnSpy.mock.calls[0][0]).toContain("placeholder");
    warnSpy.mockRestore();
  });
});

describe("ShardedDictionary (M4.5)", () => {
  function make(entries: Record<string, DictEntry[]>, size: number = 64): ShardedDictionary {
    return new ShardedDictionary(entries, size);
  }

  it("looks up entries by lazily building shards on first access", () => {
    const sd = make({
      你好: [entry("你好", "nǐ hǎo", ["hello"])],
      世界: [entry("世界", "shì jiè", ["world"])],
      苹果: [entry("蘋果", "píng guǒ", ["apple"])],
      香蕉: [entry("香蕉", "xiāng jiāo", ["banana"])],
    });
    // No shard built yet
    expect(sd.hasShard("你")).toBe(false);
    expect(sd.hasShard("世")).toBe(false);

    // First lookup builds the 你-shard
    const r1 = lookup(sd, "你好");
    expect(r1).not.toBeNull();
    expect(sd.hasShard("你")).toBe(true);
    expect(sd.hasShard("世")).toBe(false);

    // Second lookup uses a different shard
    const r2 = lookup(sd, "世界");
    expect(r2).not.toBeNull();
    expect(sd.hasShard("世")).toBe(true);
    expect(sd.hasShard("苹")).toBe(false);

    // Lookup in already-built shard returns immediately
    const r3 = lookup(sd, "苹果");
    expect(r3).not.toBeNull();
    expect(sd.hasShard("苹")).toBe(true);
  });

  it("returns null for unknown word in cached shard", () => {
    const sd = make({
      测试: [entry("測試", "cè shì", ["test"])],
    });
    lookup(sd, "测试");
    expect(lookup(sd, "未知")).toBeNull();
  });

  it("returns null for empty string", () => {
    const sd = make({
      空: [entry("空", "kōng", ["empty"])],
    });
    expect(lookup(sd, "")).toBeNull();
  });

  it("respects LRU size limit", () => {
    const sd = make({
      一: [entry("一", "yī", ["one"])],
      二: [entry("二", "èr", ["two"])],
      三: [entry("三", "sān", ["three"])],
    }, 2);
    lookup(sd, "一");
    lookup(sd, "二");
    expect(sd.size).toBe(2);
    // Third shard evicts the first
    lookup(sd, "三");
    expect(sd.size).toBe(2);
    // First shard is gone
    expect(sd.hasShard("一")).toBe(false);
    expect(sd.hasShard("二")).toBe(true);
    expect(sd.hasShard("三")).toBe(true);
  });

  it("LRU reuses already-cached shard on repeated access", () => {
    const sd = make({
      大: [entry("大", "dà", ["big"])],
      小: [entry("小", "xiǎo", ["small"])],
      新: [entry("新", "xīn", ["new"])],
    }, 2);
    lookup(sd, "大");
    lookup(sd, "小");
    expect(sd.size).toBe(2);
    // Re-access 大 (LRU recency update)
    lookup(sd, "大");
    lookup(sd, "新");
    // Should evict 小 (least recently used)
    expect(sd.hasShard("小")).toBe(false);
    expect(sd.hasShard("大")).toBe(true);
    expect(sd.hasShard("新")).toBe(true);
  });

  it("handles multi-character words using first-char shard", () => {
    const sd = make({
      青云宗: [entry("青雲宗", "qīng yún zōng", ["Azure Cloud Sect"])],
      青云: [entry("青雲", "qīng yún", ["azure clouds"])],
      青: [entry("青", "qīng", ["cyan/green"])],
    });
    expect(lookup(sd, "青云宗")).not.toBeNull();
    expect(lookup(sd, "青云")).not.toBeNull();
    expect(lookup(sd, "青")).not.toBeNull();
    // Only the 青 shard is ever needed
    expect(sd.size).toBe(1);
  });

  it("returns correct entry for words that share a leading character", () => {
    const sd = make({
      大: [entry("大", "dà", ["big"])],
      大小: [entry("大小", "dà xiǎo", ["size"])],
      大地: [entry("大地", "dà dì", ["earth/ground"])],
    });
    expect(lookup(sd, "大")).not.toBeNull();
    expect(lookup(sd, "大小")).not.toBeNull();
    expect(lookup(sd, "大地")).not.toBeNull();
    expect(sd.size).toBe(1);
  });
});

describe("lookup with ShardedDictionary and plain Map", () => {
  it("lookup works with a plain Map (backward compat)", () => {
    const m = buildMap({
      测试: [entry("測試", "cè shì", ["test"])],
    });
    expect(lookup(m, "测试")![0].d).toEqual(["test"]);
    expect(lookup(m, "未知")).toBeNull();
  });

  it("lookup works with a ShardedDictionary", () => {
    const sd = new ShardedDictionary({
      测试: [entry("測試", "cè shì", ["test"])],
    }, 64);
    expect(lookup(sd, "测试")![0].d).toEqual(["test"]);
    expect(lookup(sd, "未知")).toBeNull();
  });
});

describe("loadDictionary with sharding (M4.5)", () => {
  beforeEach(() => {
    resetDictionary();
    setLruSize(64);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    resetDictionary();
    vi.unstubAllGlobals();
  });

  it("returns a ShardedDictionary when fetching from JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        v: 1,
        entries: {
          你好: [{ t: "你好", p: "nǐ hǎo", d: ["hello"] }],
          世界: [{ t: "世界", p: "shì jiè", d: ["world"] }],
        },
      }),
    }));
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    // Should be a ShardedDictionary, not a plain Map
    expect(dict).toBeInstanceOf(ShardedDictionary);
    expect(lookup(dict, "你好")).not.toBeNull();
    expect(lookup(dict, "世界")).not.toBeNull();
    // Both shards cached
    expect((dict as ShardedDictionary).hasShard("你")).toBe(true);
    expect((dict as ShardedDictionary).hasShard("世")).toBe(true);
  });

  it("setDictionary still injects a plain Map for tests", async () => {
    const m = buildMap({
      注入: [entry("注入", "zhù rù", ["injected"])],
    });
    setDictionary(m);
    const { loadDictionary } = await import("./dictionary");
    const dict = await loadDictionary();
    // Should be the injected plain Map
    expect(dict).toBeInstanceOf(Map);
    expect(lookup(dict, "注入")![0].d).toEqual(["injected"]);
  });
});
