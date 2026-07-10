import { annotateTextNode, initAnnotator } from "./annotator";
import { collectTextNodes, containsHanzi } from "./segmenter";
import { hideTooltip, onRubyHover } from "./tooltip";

const PENDING_ATTR = "data-hanzi-pending";

// Event delegation: instead of attaching mouseenter/mouseleave to every ruby
// (expensive on long novel pages), we listen on document.body for the bubbling
// mouseover/mouseout events. mouseenter/mouseleave do not bubble, so we use
// the bubbling pair and check relatedTarget to emulate non-bubbling semantics.
const RUBY_SELECTOR = "ruby[data-word]";

let hoverListenersAttached = false;

function closestRuby(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest(RUBY_SELECTOR);
}

function handleMouseOver(e: Event): void {
  const ruby = closestRuby(e.target);
  if (!ruby) return;
  void onRubyHover(ruby);
}

function handleMouseOut(e: Event): void {
  const ruby = closestRuby(e.target);
  if (!ruby) return;
  // Only hide when the pointer leaves the ruby entirely (not when it crosses
  // into a descendant like <rb>/<rt>).
  const related = (e as MouseEvent).relatedTarget as Node | null;
  if (related && ruby.contains(related)) return;
  hideTooltip();
}

// Attach the delegated hover listeners once per page. Idempotent.
export function attachHoverListeners(): void {
  if (hoverListenersAttached) return;
  if (!document.body) return;
  document.body.addEventListener("mouseover", handleMouseOver);
  document.body.addEventListener("mouseout", handleMouseOut);
  hoverListenersAttached = true;
}

// Idle callback with graceful fallback for environments without
// requestIdleCallback (older browsers / tests).
function idle(cb: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  if (typeof ric === "function") {
    (ric as (fn: () => void) => void)(cb);
  } else {
    setTimeout(cb, 1);
  }
}

// Early CJK gate (PLAN 4.4): if the body has no CJK ideograph, exit before
// loading the dictionary or attaching observers. The bulk of <all_urls>
// pages have no Chinese, so this keeps the extension cheap on those.
function pageHasChinese(): boolean {
  return containsHanzi(document.body ? document.body.textContent ?? "" : "");
}

// Wrap a Text node in a <span data-hanzi-pending> wrapper so it has an Element
// handle for IntersectionObserver (IO only watches Elements). The wrapper is
// inline and transparent to layout. Returns the wrapper, or null if the node
// had already been removed from the DOM (race vs SPA re-render).
function wrapTextNode(node: Text): HTMLSpanElement | null {
  const parent = node.parentNode;
  if (!parent) return null;
  const span = document.createElement("span");
  span.setAttribute(PENDING_ATTR, "1");
  parent.replaceChild(span, node);
  span.appendChild(node);
  return span;
}

// Annotate a pending wrapper: unwrap the inner Text, call the annotator which
// replaces the Text with a ruby fragment, then drop the now-empty wrapper so
// the original layout is restored.
function annotatePending(span: HTMLSpanElement): void {
  if (!span.hasAttribute(PENDING_ATTR)) return; // already handled
  const textNode = span.firstChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    // Replace textNode in-place; the annotator also marks the parent (the span)
    // as annotated. Then unwrap the span to restore original layout.
    annotateTextNode(textNode as Text);
  }
  span.removeAttribute(PENDING_ATTR);
  // Unwrap: move children out, drop the span. Skip if span was removed already.
  if (!span.parentNode) return;
  while (span.firstChild) {
    span.parentNode.insertBefore(span.firstChild, span);
  }
  span.parentNode.removeChild(span);
}

// Public entry for programmatic callers (tests, future re-runs). Returns the
// count of candidate text nodes found. Reads document.body at call time.
export function runLensMode(): number {
  if (!document.body) return 0;
  if (!pageHasChinese()) return 0;
  initAnnotator();
  attachHoverListeners();

  const candidates = collectTextNodes(document.body);
  if (candidates.length === 0) return 0;

  // Memory of observed pending wrappers so re-entrant calls (MutationObserver
  // in M4) don't double-wrap. For M2 this is single-pass.
  const handled = new WeakSet<Text>();

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const span = entry.target as HTMLSpanElement;
        io.unobserve(span);
        idle(() => annotatePending(span));
      }
    },
    { rootMargin: "200px" },
  );

  for (const { node } of candidates) {
    if (handled.has(node)) continue;
    handled.add(node);
    const span = wrapTextNode(node);
    if (!span) continue;
    // If already in viewport on first pass, annotate now rather than waiting
    // for an IO fire-and-observe round-trip.
    const rect = span.getBoundingClientRect();
    const inView =
      rect.bottom > -1 &&
      rect.top < (globalThis.innerHeight ?? 1) + 1;
    if (inView) {
      annotatePending(span);
    } else {
      io.observe(span);
    }
  }

  console.info(
    "Lechyy M2: lens mode started,",
    candidates.length,
    "candidate text nodes,",
    document.querySelectorAll("ruby[data-word]").length,
    "annotated immediately",
  );
  return candidates.length;
}

// Auto-run when loaded as a real content script (not under vitest). vitest
// sets process.env.VITEST before importing test modules.
if (
  typeof process === "undefined" ||
  (process as { env?: Record<string, string | undefined> }).env?.VITEST !== "true"
) {
  runLensMode();
}
