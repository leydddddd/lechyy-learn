import { defineConfig } from "vitest/config";
import webExtension from "vite-plugin-web-extension";

// M2: full extension build via vite-plugin-web-extension. The plugin reads
// manifest.json and resolves content_scripts / html inputs as bundle entries.
// M1's standalone proof lives in m1/; to preview it manually run
//   vite --root m1
export default defineConfig({
  plugins: [webExtension()],
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
