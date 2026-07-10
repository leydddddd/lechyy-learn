# Lechyy (Chinese Reader)

Chrome Manifest V3 extension that annotates Chinese text on webpages with pinyin and provides on-hover dictionary lookup. Built for reading modern Chinese web novels in-place with minimal UI friction.

<img width="1280" height="720" alt="m1-proof" src="https://github.com/user-attachments/assets/8c1d5192-d87d-43bb-b82e-f3e72a6f1127" />

## Highlights
- Lens mode: annotate only text that enters the viewport (no revert-on-scroll in v1)
- Inline ruby markup with tone-marked pinyin via `pinyin-pro`
- Offline CC-CEDICT dictionary lookup on hover (M3)
- Early CJK gate to avoid heavy work on non-Chinese pages

## Status
- M1: Static proof of concept (done, lives in `m1/`)
- M2: Lens-mode MVP (in `content/`)
- M3: Dictionary integration + hover tooltip (done, in `content/`)
- M4: Stability pass (planned)

## Data Flow (simplified):

1. `content/index.ts`: orchestrates DOM walk, lens filtering, annotation, and hover event delegation
2. `content/segmenter.ts`: CJK detection + tokenization
3. `content/annotator.ts`: ruby injection with pinyin
4. `content/dictionary.ts`: lazy CC-CEDICT loader + O(1) lookup + user-dict overlay (M3.5 stub)
5. `content/tooltip.ts`: hover tooltip showing word + pinyin + definitions

## Project Structure

```
content/          Content script (DOM walk, segmenter, annotator)
data/             Dictionary data (cedict.json in M3)
m1/               Standalone proof of concept
popup/            Extension popup (future)
scripts/          One-off tools (dictionary build)
styles/           Shared CSS (ruby/tooltip styles)
dist-m1/          Built output for M1 proof
```

## Development

Install dependencies:

```
npm install
```

Dev server (M1 preview only):

```
npm run dev
```

Build extension output:

```
npm run build
```

Typecheck and tests:

```
npm run typecheck
npm test
```

After any TS change, always run:

```
npm run typecheck
npm test
```

## Running the Extension (Local)

1. Build: `npm run build`
2. Open Chrome `chrome://extensions`
3. Enable Developer Mode
4. Load unpacked: select the build output folder

## Dictionary Build (M3)

One-time preprocessing from raw CC-CEDICT to `data/cedict.json`:

```
npm run build:dict
```

This downloads the gzipped CC-CEDICT from MDBG, parses ~125k entries, indexes
by simplified hanzi, converts numeric pinyin to tone-marked form, and writes a
~12MB JSON file. The file is gitignored — run this step after cloning.

## Key Design Decisions

- Lens mode annotates only on enter; no revert logic in v1 to avoid DOM churn.
- Early CJK gate prevents heavy dictionary load on non-Chinese pages.
- Pure, framework-free DOM manipulation to keep the content script lightweight.

## Testing Notes

If you touch the DOM walker, segmenter, or dictionary lookup logic, add or update vitest coverage for the pure function involved. These areas are prone to subtle CJK edge cases.

## Roadmap (v1)
- M2: IntersectionObserver annotate-on-enter + early CJK gate ✓
- M3: CC-CEDICT lookup + hover tooltip ✓
- M4: MutationObserver + chunked processing for stability

## License

See [LICENSE](LICENSE).
