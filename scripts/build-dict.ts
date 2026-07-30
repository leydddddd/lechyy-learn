// One-time preprocessing: raw CC-CEDICT → data/cedict.json.
//
// Run with:  npm run build:dict
//
// Downloads the gzipped simplified-script CC-CEDICT from MDBG, parses each
// non-comment line of the form
//
//   traditional simplified [pin1 yin1 ...] /def1/def2/.../defN/
//
// and indexes entries by the simplified hanzi form so runtime lookup is O(1)
// via a plain object key. Multiple CEDICT entries can share the same
// simplified form (different traditional spellings or readings); we keep them
// all in an array so the tooltip can list every sense.
//
// Pinyin is converted from CC-CEDICT's numeric tone notation (ni3 hao3) to
// tone-marked form (nǐ hǎo) at build time so the runtime path never needs to
// do tone-number→tone-mark conversion. This matches the tone-marked output
// already produced by pinyin-pro for the ruby <rt> text.
//
// Output: data/cedict.json — a single object:
//   { v: 1, entries: Record<string, Entry[]> }
// where Entry = { t: string; p: string; d: string[] }
//   t = traditional, p = tone-marked pinyin, d = definitions

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { get } from "node:https";

import { convert } from "pinyin-pro";

const CEDICT_URL =
  "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "..", "data", "cedict.json");

export interface DictEntry {
  t: string;
  p: string;
  d: string[];
}

export interface CedictJson {
  v: number;
  entries: Record<string, DictEntry[]>;
  _placeholder?: boolean;
}

export interface CedictChecksum {
  v: number;
  downloadDate: string; // ISO date string of when the dict was downloaded
  byteLength: number; // byte length of the decompressed UTF-8 text
  sha256: string; // lowercase hex SHA-256 of the decompressed text
}

const CHECKSUM_PATH = resolve(__dirname, "..", "data", "cedict.checksum.json");

// CC-CEDICT line regex. Traditional and simplified are space-delimited and may
// contain non-hanzi (digits, latin) for entries like "120". Pinyin is in
// brackets and uses numeric tones. Definitions are slash-delimited and the
// leading+trailing slash is stripped. The optional leading "! " (variant
// marker, e.g. "#! v") is handled by skipping pure-comment lines.
const LINE_RE =
  /^(.+?)\s+(.+?)\s+\[([^\]]*)\]\s*\/(.*)\/\s*$/;

function parseLine(line: string): {
  trad: string;
  simp: string;
  pinyinRaw: string;
  defs: string[];
} | null {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const m = LINE_RE.exec(trimmed);
  if (!m) return null;
  const [, trad, simp, pinyinRaw, defsRaw] = m;
  const defs = defsRaw.split("/").filter((d) => d.length > 0);
  if (defs.length === 0) return null;
  return { trad, simp, pinyinRaw, defs };
}

// Convert CC-CEDICT numeric pinyin ("ni3 hao3") to tone-marked ("nǐ hǎo").
// pinyin-pro's `convert` handles the full range including ü and neutral tone
// (no digit). We pass the raw space-joined syllable string straight through;
// the result is what the tooltip displays.
function toMarked(pinyinRaw: string): string {
  return convert(pinyinRaw);
}

function downloadAndGunzip(url: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const req = get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        res.destroy();
        if (typeof loc === "string") {
          downloadAndGunzip(loc).then(resolveP, rejectP);
        } else {
          rejectP(new Error("Redirect without Location header"));
        }
        return;
      }
      if (res.statusCode !== 200) {
        res.destroy();
        rejectP(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      const gunzip = createGunzip();
      res.pipe(gunzip);
      gunzip.on("data", (c: Buffer) => chunks.push(c));
      gunzip.on("end", () => resolveP(Buffer.concat(chunks).toString("utf8")));
      gunzip.on("error", rejectP);
    });
    req.on("error", rejectP);
  });
}

export function buildIndex(raw: string): CedictJson {
  const entries: Record<string, DictEntry[]> = {};
  let count = 0;
  let skipped = 0;

  for (const line of raw.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) {
      if (line.trim() && !line.startsWith("#")) skipped++;
      continue;
    }
    const { trad, simp, pinyinRaw, defs } = parsed;
    const p = toMarked(pinyinRaw);
    const entry: DictEntry = { t: trad, p, d: defs };
    const arr = entries[simp];
    if (arr) arr.push(entry);
    else entries[simp] = [entry];
    count++;
  }

  console.info(
    `Parsed ${count} entries (${skipped} non-comment lines skipped), ` +
      `${Object.keys(entries).length} unique simplified keys.`,
  );
  return { v: 1, entries };
}

async function main(): Promise<void> {
  console.info(`Downloading CC-CEDICT from ${CEDICT_URL} …`);
  const raw = await downloadAndGunzip(CEDICT_URL);

  // Compute provenance data from the decompressed text.
  const byteLength = Buffer.byteLength(raw, "utf8");
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  const checksum: CedictChecksum = {
    v: 1,
    downloadDate: new Date().toISOString().split("T")[0],
    byteLength,
    sha256,
  };

  // Check against any existing checksum file — warn on drift.
  try {
    const existing = JSON.parse(
      await readFile(CHECKSUM_PATH, "utf8"),
    ) as CedictChecksum;
    if (existing.sha256 !== sha256) {
      console.warn(
        `WARNING: upstream CC-CEDICT changed since the last build. ` +
          `Old sha256: ${existing.sha256}, new: ${sha256}.`,
      );
    } else {
      console.info("Checksum match: no upstream drift detected.");
    }
  } catch {
    // No existing checksum file — first build, safe to proceed.
    console.info("No existing checksum found — first build.");
  }

  const index = buildIndex(raw);

  await mkdir(dirname(OUT_PATH), { recursive: true });

  // Pretty-printed is human-auditable; the file is large either way (~12MB)
  // and Chrome serves it locally with no compression concern for personal use.
  const json = JSON.stringify(index, null, 0);
  await new Promise<void>((resolveP, rejectP) => {
    const ws = createWriteStream(OUT_PATH);
    ws.on("error", rejectP);
    ws.on("finish", () => resolveP());
    ws.end(json);
  });

  const sizeMb = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
  console.info(`Wrote ${OUT_PATH} (${sizeMb} MB)`);

  // Persist the checksum file alongside the dict.
  await writeFile(
    CHECKSUM_PATH,
    JSON.stringify(checksum, null, 0) + "\n",
    "utf8",
  );
  console.info(`Wrote ${CHECKSUM_PATH}`);
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
