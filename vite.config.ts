import { defineConfig } from "vite";

// M1 only: standalone preview. The web-extension plugin and content-script
// wiring turn on in M2, once content/index.ts exists. For now we serve the
// mo1/ proof-of-concept directly so `npm run dev` = ruby + pinyin + tone
// colors validation with no extension overhead.
export default defineConfig({
  root: "m1",
  build: {
    outDir: "../dist-m1",
    emptyOutDir: true,
  },
});
