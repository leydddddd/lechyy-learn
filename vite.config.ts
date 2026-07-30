import { defineConfig } from "vitest/config";
import webExtension from "vite-plugin-web-extension";

// M2: full extension build via vite-plugin-web-extension. The plugin reads
// manifest.json and resolves content_scripts / html inputs as bundle entries.
// M3: `data/` is the Vite publicDir so cedict.json + user-dict.json land at the
// extension root (dist/) and are fetchable via chrome.runtime.getURL("cedict.json").
// The build-dict step writes data/cedict.json before `vite build` runs. If the
// real file is absent at build time, `scripts/placeholder.js` writes a 3-entry
// placeholder with `v: 0, _placeholder: true` and prints a banner. At runtime,
// `dictionary.ts` detects `isPlaceholder` and emits a [lechyy] console.warn.
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
