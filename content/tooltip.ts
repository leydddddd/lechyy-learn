// Hover tooltip for annotated ruby elements. A single shared <div> is mounted
// once to document.body and repositioned on each hover. No framework — plain
// DOM.
//
// Layout (PLAN §4.5):
//
//   汉字   hàn zì
//   ────────────────
//   1. Chinese character; Chinese script
//   2. CJK character
//
// When the word has no CEDICT entry, the tooltip shows the per-character
// pinyin (read from the ruby's own <rt> children, which pinyin-pro already
// populated) and "No dictionary entry" instead of definitions.

import type { DictEntry } from "./dictionary";

const TOOLTIP_ID = "hanzi-tooltip";
const VISIBLE_CLASS = "hanzi-tooltip--visible";

let tooltipEl: HTMLDivElement | null = null;
let scrollListener: (() => void) | null = null;

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl && tooltipEl.isConnected) return tooltipEl;
  const el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.setAttribute("data-hanzi", "tooltip");
  el.style.display = "none";
  document.body.appendChild(el);
  tooltipEl = el;
  return el;
}

// Extract the per-character pinyin from a ruby element's <rt> children. The
// annotator already wrote tone-marked pinyin there, so this is the cheapest
// fallback source and is always consistent with the visible ruby text.
function pinyinFromRuby(ruby: Element): string {
  const rts = ruby.querySelectorAll("rt");
  return Array.from(rts)
    .map((rt) => rt.textContent ?? "")
    .join(" ")
    .trim();
}

function renderEntry(word: string, entry: DictEntry): string {
  const defs = entry.d
    .map((d, i) => `<li>${i + 1}. ${escapeHtml(d)}</li>`)
    .join("");
  return (
    `<div class="hanzi-tooltip__word">${escapeHtml(word)}</div>` +
    `<div class="hanzi-tooltip__pinyin">${escapeHtml(entry.p)}</div>` +
    (defs ? `<ul class="hanzi-tooltip__defs">${defs}</ul>` : "")
  );
}

function renderFallback(word: string, pinyin: string): string {
  return (
    `<div class="hanzi-tooltip__word">${escapeHtml(word)}</div>` +
    `<div class="hanzi-tooltip__pinyin">${escapeHtml(pinyin)}</div>` +
    `<div class="hanzi-tooltip__noentry">No dictionary entry</div>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function positionTooltip(
  el: HTMLDivElement,
  rect: DOMRect,
): void {
  const margin = 8;
  // Place below the ruby by default; flip above if it would overflow the
  // viewport bottom.
  const tooltipHeight = el.offsetHeight || 100;
  const below = rect.bottom + margin;
  const above = rect.top - margin - tooltipHeight;
  const winH = globalThis.innerHeight ?? 800;

  let top: number;
  if (below + tooltipHeight > winH && above > 0) {
    top = above;
  } else {
    top = below;
  }

  // Center horizontally on the ruby, clamped to the viewport.
  const winW = globalThis.innerWidth ?? 800;
  const tooltipWidth = el.offsetWidth || 200;
  let left = rect.left + rect.width / 2 - tooltipWidth / 2;
  left = Math.max(margin, Math.min(left, winW - tooltipWidth - margin));

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

export interface TooltipShowOptions {
  word: string;
  rubyRect: DOMRect;
  entries: DictEntry[] | null;
  fallbackPinyin: string;
}

export function showTooltip(opts: TooltipShowOptions): void {
  const el = ensureTooltip();
  const { word, rubyRect, entries, fallbackPinyin } = opts;

  if (entries && entries.length > 0) {
    // CEDICT hit: show the first entry's definitions. Multiple entries with
    // the same simplified form are rare for common words; showing the first
    // keeps the tooltip compact. The full list is available for a future
    // "expand" affordance.
    el.innerHTML = renderEntry(word, entries[0]);
  } else {
    el.innerHTML = renderFallback(word, fallbackPinyin);
  }

  el.style.display = "block";
  el.classList.add(VISIBLE_CLASS);
  positionTooltip(el, rubyRect);
}

export function hideTooltip(): void {
  if (!tooltipEl) return;
  tooltipEl.classList.remove(VISIBLE_CLASS);
  tooltipEl.style.display = "none";
}

// Attach a scroll listener that hides the tooltip. Called once on first hover
// so we don't pay the listener cost on pages where the user never hovers.
export function attachScrollDismiss(): void {
  if (scrollListener) return;
  scrollListener = () => hideTooltip();
  window.addEventListener("scroll", scrollListener, { passive: true, capture: true });
}

// The hover handler invoked when the pointer enters a ruby[data-word] element.
// Fetches the dictionary lazily on first use, then shows the tooltip.
export async function onRubyHover(ruby: Element): Promise<void> {
  attachScrollDismiss();
  const word = ruby.getAttribute("data-word") ?? "";
  const rubyRect = ruby.getBoundingClientRect();
  const fallbackPinyin = pinyinFromRuby(ruby);

  // Late import to avoid loading dictionary module state at content-script init
  // time. The dynamic import + fetch only happens on the first hover.
  const { loadDictionary, lookup } = await import("./dictionary");
  let entries: DictEntry[] | null = null;
  try {
    const dict = await loadDictionary();
    entries = lookup(dict, word);
  } catch {
    // Dictionary unavailable (fetch failed, not built). Fall through to the
    // fallback tooltip so the user still gets pinyin.
    entries = null;
  }
  showTooltip({ word, rubyRect, entries, fallbackPinyin });
}

// Detach the scroll listener — used by tests for cleanup.
export function detachScrollDismiss(): void {
  if (!scrollListener) return;
  window.removeEventListener("scroll", scrollListener, { capture: true } as EventListenerOptions);
  scrollListener = null;
}

export function destroyTooltip(): void {
  detachScrollDismiss();
  if (tooltipEl && tooltipEl.parentNode) {
    tooltipEl.parentNode.removeChild(tooltipEl);
  }
  tooltipEl = null;
}
