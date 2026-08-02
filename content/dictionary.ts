// Runtime CC-CEDICT lookup. Loads the preprocessed JSON lazily on first use
// (not at content-script init) so the ~12MB file never blocks first paint —
// the PLAN §7 R6 perf issue was caused by eager loading; M3 keeps CEDICT off
// the critical path entirely by deferring to the first hover.
//
// The JSON is fetched via chrome.runtime.getURL so it works in the MV3 content
// script isolated world (file listed in manifest web_accessible_resources).
//
// M3.5: user-created entries stored in chrome.storage.local are merged on top
// of CEDICT so per-novel glossary entries override/augment the base dictionary.
// The optional data/user-dict.json seed file is also merged if present (import
// format, also listed as web_accessible_resource). Storage entries win over
// seed-file entries, and both win over CEDICT.
//
// M4.5: Lazy LRU shard cache. The full ~12MB JSON is stored as a plain
// Record and parsed into per-char shards on first .get() access. Only shards
// actually accessed by the user's hovered words are held in an LRU cache (max
// 64 shards by default), so typical reading sessions hold only a fraction of
// the dictionary in heap. loadDictionary() returns a DictLike (Map |
// ShardedDictionary) with a .get() method so it remains drop-in compatible
// with lookup() and every existing test.

import type { CedictJson, DictEntry } from "../scripts/build-dict";

export type { DictEntry } from "../scripts/build-dict";

const CEDICT_RESOURCE = "cedict.json";
const USER_DICT_RESOURCE = "user-dict.json";
const STORAGE_KEY = "userDict";
const DOMAINS_STORAGE_KEY = "lechyy";

// M4.5: Lazy LRU shard cache for CEDICT.
const DEFAULT_LRU_SIZE = 64;
let lruSizeConfig = DEFAULT_LRU_SIZE;

// Exposed so tests can override the LRU size for bounded-memory tests.
export function setLruSize(n: number): void {
  lruSizeConfig = n;
}

// Lightweight LRU wrapper around a plain Map. Evicts oldest on insert when full.
class LruMap {
  private cache: Map<string, Map<string, DictEntry[]>>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key: string): Map<string, DictEntry[]> | undefined {
    const val = this.cache.get(key);
    if (!val) return undefined;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key: string, val: Map<string, DictEntry[]>): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first entry in insertion order)
      const oldest = this.cache.keys().next();
      if (oldest.done === false) this.cache.delete(oldest.value);
    }
    this.cache.set(key, val);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * A lazily-sharded dictionary that presents a Map-like .get() interface.
 *
 * Under the hood it stores the raw entries as a plain `Record<string, DictEntry[]>`
 * (not a `Map`).  When `.get(word)` is called, it checks the shard cache for the
 * leading-hanzi shard, building it on demand if absent.
 *
 * Exported for tests so they can inspect shards without loading the full map.
 */
export class ShardedDictionary {
  private raw: Record<string, DictEntry[]>;
  private shards: LruMap;

  constructor(entries: Record<string, DictEntry[]>, maxSize: number) {
    this.raw = entries;
    this.shards = new LruMap(maxSize);
  }

  /**
   * Get entry for a word. Builds the leading-character shard lazily if needed.
   */
  get(word: string): DictEntry[] | undefined {
    if (!word.length) return undefined;
    const firstChar = word.charAt(0);

    let shard = this.shards.get(firstChar);
    if (!shard) {
      shard = buildCharacterShard(this.raw, firstChar);
      this.shards.set(firstChar, shard);
    }
    return shard.get(word);
  }

  /**
   * Get a shard by leading character (for tests).
   */
  getShard(char: string): Map<string, DictEntry[]> | undefined {
    return this.shards.get(char);
  }

  /**
   * Check if a shard exists in the cache.
   */
  hasShard(char: string): boolean {
    return this.shards.has(char);
  }

  get size(): number {
    return this.shards.size;
  }
}

/**
 * Build a shard Map for entries whose key starts with `char`.
 */
function buildCharacterShard(
  entries: Record<string, DictEntry[]>,
  char: string,
): Map<string, DictEntry[]> {
  const shard = new Map<string, DictEntry[]>();
  for (const [key, value] of Object.entries(entries)) {
    if (key.charAt(0) === char) {
      if (value.length > 0) shard.set(key, value);
    }
  }
  return shard;
}

// Module-level state for loadDictionary/sharding. When running in production
// (fetched JSON), loadDictionary creates a ShardedDictionary so the ~12MB JSON
// is never fully materialised in heap. Tests that inject a Map via
// setDictionary() cause that map to be returned directly.
type DictLike = Map<string, DictEntry[]> | ShardedDictionary;

let dictSource: DictLike | null = null;
let loadPromise: Promise<DictLike> | null = null;

// Per-domain allowlist (v2.0): reads { lechyy: { domains: ["example.com"] } }
// from chrome.storage.local.  If the key is absent, all domains are allowed
// (preserves existing behaviour).  If present, only listed domains are allowed.
// Exported for tests.
export async function isDomainAllowed(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return true;
  }
  try {
    const result = await chrome.storage.local.get(DOMAINS_STORAGE_KEY);
    const lechyy = result[DOMAINS_STORAGE_KEY];
    // Key absent = allow on all domains (default: on everywhere)
    if (!lechyy || typeof lechyy !== "object" || !("domains" in lechyy)) {
      return true;
    }
    const domains = lechyy.domains;
    // Invalid domains list = allow on all domains (fail open)
    if (!Array.isArray(domains)) return true;
    // Use host without port, with optional trailing slash stripped
    const host = (globalThis.location?.host ?? "").replace(/:\d+$/, "").replace(/\/.*$/, "");
    return domains.includes(host);
  } catch {
    // On error, allow on all domains (fail open)
    return true;
  }
}

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
  dict: Map<string, DictEntry[]> | ShardedDictionary,
  word: string,
): DictEntry[] | null {
  const entries = "get" in dict ? dict.get(word) : undefined;
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

function isPlaceholder(raw: CedictJson): boolean {
  return (
    typeof raw._placeholder === "boolean" &&
    raw._placeholder &&
    raw.v === 0
  );
}

// Read user-dict entries from chrome.storage.local. Returns a plain
// Record<string, DictEntry[]> suitable for mergeOverlay, or null if storage
// is empty / unavailable / malformed (silent no-op, base dict still works).
// Exported for tests.
export async function getUserDictEntries(): Promise<Record<string, DictEntry[]> | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return null;
  }
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    if (raw && isEntryRecord(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

// Write a single entry to the user dict in chrome.storage.local. Preserves
// existing entries under other keys. Used by future UI (★-to-save in v2.0)
// and by import paths. Exported for tests.
export async function setUserEntry(
  word: string,
  entry: DictEntry,
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return;
  }
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const existing: Record<string, DictEntry[]> =
    result[STORAGE_KEY] && isEntryRecord(result[STORAGE_KEY])
      ? (result[STORAGE_KEY] as Record<string, DictEntry[]>)
      : {};
  existing[word] = [entry];
  await chrome.storage.local.set({ [STORAGE_KEY]: existing });
}

// Extract the set of simplified words currently in the user dict (for the
// custom-term pre-segmentation pass in annotator.ts). Returns a sorted array
// of custom terms (longest first so the longest-match greedy split works).
// Exported for tests and for the annotator.
export async function getCustomTerms(): Promise<string[]> {
  const entries = await getUserDictEntries();
  if (!entries) return [];
  return Object.keys(entries).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

// Load CEDICT + optional user-dict overlay into the module-level dict source.
// The promise is cached so subsequent calls reuse the same load.
// Errors during user-dict load are swallowed (overlay is optional); CEDICT
// errors propagate.
//
// Returns either a ShardedDictionary (production path) or an injected Map
// (test/injected path). Returns something with .get() for drop-in lookup()
// compatibility.
export async function loadDictionary(): Promise<DictLike> {
  if (dictSource) return dictSource;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const raw = await fetchJson(CEDICT_RESOURCE);
    if (!isCedictJson(raw)) {
      throw new Error("cedict.json: invalid format (missing .entries)");
    }
    if (isPlaceholder(raw)) {
      console.warn("[lechyy] cedict.json is placeholder data — tooltips will be inaccurate. Run npm run build:dict to install the real CC-CEDICT dictionary.");
    }

    // Start with base CEDICT as a plain Map (needed for mergeOverlay which takes Map<>)
    let mergedMap = buildMap(raw.entries as Record<string, DictEntry[]>);

    // M3.5 overlay: seed file first (optional import format), then storage
    // on top so user-created entries always win over both seed and CEDICT.
    try {
      const overlayRaw = await fetchJson(USER_DICT_RESOURCE);
      if (overlayRaw && isEntryRecord(overlayRaw)) {
        mergedMap = mergeOverlay(mergedMap, overlayRaw as Record<string, DictEntry[]>);
      }
    } catch {
      // No user dict seed file — expected. Not an error.
    }

    const userEntries = await getUserDictEntries();
    if (userEntries) {
      mergedMap = mergeOverlay(mergedMap, userEntries);
    }

    // Convert the merged plain Map to a plain Record, then wrap in ShardedDictionary.
    // The ShardedDictionary stores entries as a simple Record (no Map overhead)
    // and builds per-char shards only on first .get() access.
    const mergedRecord: Record<string, DictEntry[]> = {};
    for (const [k, v] of mergedMap) {
      mergedRecord[k] = v;
    }
    dictSource = new ShardedDictionary(mergedRecord, lruSizeConfig);

    return dictSource;
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
  dictSource = map;
  loadPromise = Promise.resolve(map);
}

// Reset module state — used by tests to ensure isolation between cases.
export function resetDictionary(): void {
  dictSource = null;
  loadPromise = null;
}
