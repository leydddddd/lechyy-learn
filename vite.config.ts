import { defineConfig } from "vitest/config";
import webExtension from "vite-plugin-web-extension";

// M2: full extension build via vite-plugin-web-extension. The plugin reads
// manifest.json and resolves content_scripts / html inputs as bundle entries.
// M1's standalone proof lives in m1/; to preview it manually run
//   vite --root m1
//
// M3: `data/` is the Vite publicDir so cedict.json + user-dict.json land at the
// extension root (dist/) and are fetchable via chrome.runtime.getURL("cedict.json").
// The build-dict step writes data/cedict.json before `vite build` runs; if the
// real file is absent a placeholder is used so the extension still loads (every
// lookup falls through to the per-character pinyin fallback).
export default defineConfig({
  plugins: [webExtension()],
  publicDir: "data",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["**/*.test.ts"],
  },
});
