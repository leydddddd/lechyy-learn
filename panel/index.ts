import { annotateTextSync, ensureAnnotator } from "../content/annotator";
import { collectLeafBlocks, collectTextNodes } from "../content/segmenter";
import { extractArticle } from "../content/sentence";
import panelStyles from "./panel.css?inline";

let panelRoot: ShadowRoot | null = null;
let pinyinVisible = true;

interface PanelRow {
  chineseHtml: string;
  pinyinText: string;
  englishText: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPinyinText(rubyEl: HTMLElement): string {
  const rts = rubyEl.querySelectorAll("rt");
  return Array.from(rts)
    .map((rt) => rt.textContent ?? "")
    .join(" ")
    .trim();
}

function extractRowsFromPage(): PanelRow[] {
  const blocks = collectLeafBlocks(document.body);
  if (blocks.length === 0) return [];

  const sentences = extractArticle(blocks);
  const rows: PanelRow[] = [];

  for (const sentence of sentences.slice(0, 50)) {
    const block = blocks[sentence.blockIndex];
    if (!block) continue;

    const candidates = collectTextNodes(block.element);
    let fullAnnotatedHtml = "";
    const allPinyinParts: string[] = [];

    for (const { node } of candidates) {
      if (!node.parentNode) continue;
      const text = node.nodeValue ?? "";
      const frag = annotateTextSync(text);
      const htmlParts: string[] = [];
      for (const child of Array.from(frag.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const el = child as HTMLElement;
          htmlParts.push(el.outerHTML);
          if (el.tagName === "RUBY") {
            const py = buildPinyinText(el);
            if (py) allPinyinParts.push(py);
          }
        } else {
          const txt = child.textContent ?? "";
          htmlParts.push(escapeHtml(txt));
        }
      }
      fullAnnotatedHtml += htmlParts.join("");
    }

    rows.push({
      chineseHtml: fullAnnotatedHtml,
      pinyinText: allPinyinParts.join(" "),
      englishText: "",
    });
  }

  return rows;
}

function renderRows(rows: PanelRow[], shadow: ShadowRoot): void {
  const body = shadow.querySelector(".lechyy-panel-body");
  if (!body) return;

  if (rows.length === 0) {
    body.innerHTML = `<div class="lechyy-panel-empty">No Chinese sentences found on this page.</div>`;
    return;
  }

  body.innerHTML = rows
    .map(
      (row) => `
        <div class="lechyy-panel-row">
          <div class="lechyy-panel-row-ruby">${row.chineseHtml}</div>
          <div class="lechyy-panel-row-pinyin${pinyinVisible ? "" : " hidden"}">${escapeHtml(row.pinyinText)}</div>
          <div class="lechyy-panel-row-english skeleton">${row.englishText || "Translation pending…"}</div>
        </div>
      `,
    )
    .join("");
}

function buildPanel(rows: PanelRow[]): ShadowRoot {
  const host = document.createElement("div");
  host.id = "lechyy-panel-host";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = panelStyles;
  shadow.appendChild(style);

  const container = document.createElement("div");
  container.className = "lechyy-panel";
  shadow.appendChild(container);

  container.innerHTML = `
    <div class="lechyy-panel-header">
      <h2>Lechyy — Side Panel</h2>
      <div class="lechyy-panel-controls">
        <label class="lechyy-panel-toggle">
          <input type="checkbox" checked /> 拼音
        </label>
        <button class="lechyy-panel-close" aria-label="Close panel">&times;</button>
      </div>
    </div>
    <div class="lechyy-panel-body"></div>
  `;

  document.body.appendChild(host);

  const pinyinCheckbox = container.querySelector(
    '.lechyy-panel-toggle input[type="checkbox"]',
  ) as HTMLInputElement;
  pinyinCheckbox.addEventListener("change", () => {
    pinyinVisible = pinyinCheckbox.checked;
    const pinyinEls = container.querySelectorAll(".lechyy-panel-row-pinyin");
    for (const el of Array.from(pinyinEls)) {
      el.classList.toggle("hidden", !pinyinVisible);
    }
  });

  const closeBtn = container.querySelector(".lechyy-panel-close") as HTMLButtonElement;
  closeBtn.addEventListener("click", () => {
    host.remove();
    panelRoot = null;
  });

  renderRows(rows, shadow);

  panelRoot = shadow;
  return shadow;
}

export async function showPanel(): Promise<boolean> {
  if (panelRoot) {
    return true;
  }

  await ensureAnnotator();
  const rows = extractRowsFromPage();
  buildPanel(rows);
  return true;
}

export function hidePanel(): boolean {
  const host = document.getElementById("lechyy-panel-host");
  if (host) {
    host.remove();
  }
  panelRoot = null;
  return false;
}

export function isPanelActive(): boolean {
  return panelRoot !== null;
}