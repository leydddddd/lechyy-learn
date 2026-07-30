import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PLACEHOLDER = {
  v: 0,
  _placeholder: true,
  entries: {
    你好: [
      { t: "你好", p: "nǐ hǎo", d: ["Placeholder gloss — run npm run build:dict"] },
    ],
    汉字: [
      { t: "漢字", p: "hàn zì", d: ["Placeholder gloss — run npm run build:dict"] },
    ],
    学习: [
      { t: "學習", p: "xué xí", d: ["Placeholder gloss — run npm run build:dict"] },
    ],
  },
};

const DATA_DIR = resolve(__dirname, "..", "data");
const OUT_PATH = join(DATA_DIR, "cedict.json");

if (!existsSync(OUT_PATH)) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(PLACEHOLDER, null, 0));
  console.warn(
    "[lechyy] cedict.json missing — tooltips will show placeholder data.\n" +
      "       Run npm run build:dict to download the real CC-CEDICT dictionary."
  );
}
