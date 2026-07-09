# Lechyy (Chinese Reader)

Chrome Manifest V3 extension that annotates Chinese text on webpages with pinyin and provides on-hover dictionary lookup. Built for reading modern Chinese web novels in-place with minimal UI friction.

![M1 proof](m1-proof.png)

## Highlights
- Lens mode: annotate only text that enters the viewport (no revert-on-scroll in v1)
- Inline ruby markup with tone-marked pinyin via `pinyin-pro`
- Offline CC-CEDICT dictionary lookup on hover (M3)
- Early CJK gate to avoid heavy work on non-Chinese pages

## Status
- M1: Static proof of concept (done, lives in `m1/`)
- M2: Lens-mode MVP (in `content/`)
- M3: Dictionary integration (planned)
- M4: Stability pass (planned)

## Architecture Overview
Content script runs on matching pages, walks text nodes, segments CJK, injects ruby markup, and attaches hover handlers.

Data flow (simplified):

1. `content/index.ts`: orchestrates DOM walk, lens filtering, and annotation
2. `content/segmenter.ts`: CJK detection + tokenization
3. `content/annotator.ts`: ruby injection with pinyin
4. Dictionary lookup and tooltip UI are planned for M3

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

## Key Design Decisions

- Lens mode annotates only on enter; no revert logic in v1 to avoid DOM churn.
- Early CJK gate prevents heavy dictionary load on non-Chinese pages.
- Pure, framework-free DOM manipulation to keep the content script lightweight.

## Testing Notes

If you touch the DOM walker, segmenter, or dictionary lookup logic, add or update vitest coverage for the pure function involved. These areas are prone to subtle CJK edge cases.

## Roadmap (v1)

- M2: IntersectionObserver annotate-on-enter + early CJK gate
- M3: CC-CEDICT lookup + hover tooltip
- M4: MutationObserver + chunked processing for stability

## License

See [LICENSE](LICENSE).
