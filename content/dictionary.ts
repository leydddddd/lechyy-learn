// Runtime CC-CEDICT lookup. Loads the preprocessed JSON lazily on first use
// (not at content-script init) so the ~12MB file never blocks first paint —
// the PLAN §7 R6 perf issue was caused by eager loading; M3 keeps CEDICT off
// the critical path entirely by deferring to the first hover.
//
// The JSON is fetched via chrome.runtime.getURL so it works in the MV3 content
// script isolated world (file listed in manifest web_accessible_resources).
//
// M3.5 prep: a user-dict overlay (data/user-dict.json) is merged on top of
// CEDICT so per-novel glossary entries override/augment the base dictionary.
// The overlay file is optional — its absence is a silent no-op.

import type { CedictJson, DictEntry } from "../scripts/build-dict";

export type { DictEntry } from "../scripts/build-dict";

const CEDICT_RESOURCE = "cedict.json";
const USER_DICT_RESOURCE = "user-dict.json";

let dictMap: Map<string, DictEntry[]> | null = null;
let loadPromise: Promise<Map<string, DictEntry[]>> | null = null;

// Build a Map from the raw entries object. Pure — exported for tests so they
// can construct a dictionary without hitting the network.
export function buildMap(entries: Record<string, DictEntry[]>): Map<string, DictEntry[]> {
  return new Map(Object.entries(entries));
}

// Merge a base dictionary with a user overlay. Overlay entries *replace* base
// entries for the same key (the user's glossary wins). Keys present only in the
// overlay are added. Pure — exported for tests.
export function mergeOverlay(
  base: Map<string, DictEntry[]>,
  overlay: Record<string, DictEntry[]>,
): Map<string, DictEntry[]> {
  const merged = new Map(base);
  for (const [key, entries] of Object.entries(overlay)) {
    merged.set(key, entries);
  }
  return merged;
}

// O(1) lookup by simplified hanzi word. Returns all matching entries (a
// simplified form may have multiple traditional/reading variants in CEDICT).
// Returns null when there is no entry — callers use this to trigger the
// per-character pinyin fallback (PLAN §4.4).
export function lookup(
  dict: Map<string, DictEntry[]>,
  word: string,
): DictEntry[] | null {
  const entries = dict.get(word);
  if (!entries || entries.length === 0) return null;
  return entries;
}

function resolveUrl(resource: string): string {
  // In the extension, chrome.runtime.getURL gives the extension-origin URL.
  // Under vitest/jsdom this global is absent; callers that need the dict in
  // tests inject it directly via setDictionary / buildMap, so we never reach
  // this branch in tests.
  const chromeApi = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome;
  if (chromeApi?.runtime?.getURL) {
    return chromeApi.runtime.getURL(resource);
  }
  return resource;
}

async function fetchJson(resource: string): Promise<unknown> {
  const url = resolveUrl(resource);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Dictionary fetch failed: ${res.status} for ${url}`);
  }
  return res.json();
}

function isCedictJson(v: unknown): v is CedictJson {
  return (
    typeof v === "object" &&
    v !== null &&
    "entries" in v &&
    typeof (v as CedictJson).entries === "object"
  );
}

function isEntryRecord(v: unknown): v is Record<string, DictEntry[]> {
  if (typeof v !== "object" || v === null) return false;
  for (const val of Object.values(v)) {
    if (!Array.isArray(val)) return false;
  }
  return true;
}

// Load CEDICT + optional user-dict overlay into the module-level Map. The
// promise is cached so subsequent calls reuse the same load. Errors during
// user-dict load are swallowed (overlay is optional); CEDICT errors propagate.
export async function loadDictionary(): Promise<Map<string, DictEntry[]>> {
  if (dictMap) return dictMap;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const raw = await fetchJson(CEDICT_RESOURCE);
    if (!isCedictJson(raw)) {
      throw new Error("cedict.json: invalid format (missing .entries)");
    }
    let map = buildMap(raw.entries);

    // M3.5 overlay: user-dict.json is optional. If present and well-formed,
    // its entries override CEDICT for the same key. A 404 or parse failure is
    // a silent no-op — the base dictionary still works.
    try {
      const overlayRaw = await fetchJson(USER_DICT_RESOURCE);
      if (overlayRaw && isEntryRecord(overlayRaw)) {
        map = mergeOverlay(map, overlayRaw);
      }
    } catch {
      // No user dict yet — expected for M3. Not an error.
    }

    dictMap = map;
    return map;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    // Reset so a retry can be attempted rather than caching the failure.
    loadPromise = null;
    throw err;
  }
}

// Test/programmatic injection: set the dictionary directly, bypassing fetch.
// Useful for unit tests that want to exercise lookup without the real JSON.
export function setDictionary(map: Map<string, DictEntry[]>): void {
  dictMap = map;
  loadPromise = Promise.resolve(map);
}

// Reset module state — used by tests to ensure isolation between cases.
export function resetDictionary(): void {
  dictMap = null;
  loadPromise = null;
}
