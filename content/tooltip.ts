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

// Hover generation counter (M4.7): monotonically-increasing counter so a
// late in-flight lookup cannot reopen the tooltip after pointer exit or
// overwrite a more recently-hovered word.  beginHover() is called at the
// start of onRubyHover; dismissHover() fires on mouseout (from index.ts)
// and on scroll (below).
let hoverGen = 0;

export function getHoverGen(): number { return hoverGen; }
export function beginHover(): number { return ++hoverGen; }
export function dismissHover(): void { hoverGen++; }

const TOOLTIP_ID = "hanzi-tooltip";
const VISIBLE_CLASS = "hanzi-tooltip--visible";

// The data-hanzi="tooltip" attribute is the single source of truth for idempotency.
// reinjection: if this module runs a second time on the same frame, any residual
// event-listener closures from the previous run are harmless — they operate on a
// detached node and do nothing.  We do NOT attempt to remove those closures; doing
// so is impossible (addEventListener has no "remove all listeners by handler" API).
// Instead we make them harmless by destroying the DOM node they target.
const TOOLTIP_SELECTOR = '[data-hanzi="tooltip"]';

let tooltipEl: HTMLDivElement | null = null;
let scrollListener: (() => void) | null = null;

function ensureTooltip(): HTMLDivElement {
  // Short-circuit: still connected and we have a live reference.
  if (tooltipEl && tooltipEl.isConnected) return tooltipEl;

  // Reinject / orphan adoption: a tooltip node may already exist in the DOM
  // (created by a previous module instance). Adopt it so orphaned listeners
  // from older modules that later call ensureTooltip will get the SAME node.
  const existing = document.querySelector(TOOLTIP_SELECTOR) as HTMLDivElement | null;
  if (existing) {
    tooltipEl = existing;
    return existing;
  }

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

// Attach a scroll listener that hides the tooltip and invalidates in-flight
// lookups (M4.7 generation counter) so the tooltip cannot reappear after
// the user has scrolled past the hovered ruby.
export function attachScrollDismiss(): void {
  if (scrollListener) return;
  scrollListener = () => {
    hideTooltip();
    dismissHover();  // M4.7: invalidate in-flight lookups
  };
  window.addEventListener("scroll", scrollListener, { passive: true, capture: true });
}

export async function onRubyHover(ruby: Element): Promise<void> {
  attachScrollDismiss();
  const word = ruby.getAttribute("data-word") ?? "";
  const rubyRect = ruby.getBoundingClientRect();
  const fallbackPinyin = pinyinFromRuby(ruby);

  // Capture generation at the start of this hover request (M4.7).
  const myGen = beginHover();

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

  // Only show if this request is still the current one (M4.7).  A late
  // lookup cannot reopen the tooltip after the user has left the ruby or
  // moved to a newer one.
  if (myGen === hoverGen) {
    showTooltip({ word, rubyRect, entries, fallbackPinyin });
  }
}

// Detach the scroll listener — used by tests for cleanup.
export function detachScrollDismiss(): void {
  if (!scrollListener) return;
  window.removeEventListener("scroll", scrollListener, { capture: true } as EventListenerOptions);
  scrollListener = null;
}

export function destroyTooltip(): void {
  detachScrollDismiss();
  // Use the data attribute selector so we always find the tooltip node even if
  // tooltipEl was nullified by a previous reinjection.
  document.querySelectorAll(TOOLTIP_SELECTOR).forEach((n) => n.remove());
}
