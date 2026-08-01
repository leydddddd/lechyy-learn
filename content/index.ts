import { annotateTextNode, ensureAnnotator } from "./annotator";
import { collectTextNodes, containsHanzi } from "./segmenter";
import { destroyTooltip, hideTooltip, onRubyHover } from "./tooltip";

// Reinjection guard (0.4): mark that this script has loaded. On reinject, clean
// up any pre-existing tooltip node.  Residual event-listener closures from older
// script instances are impossible to remove (addEventListener has no
// "unregister-all" API), so we make them harmless — their closures reference a
// module-state object whose `tooltipEl` is now null, and `destroyTooltip` wipes
// the DOM node.  Orphaned listeners remain on document.body but operate on a
// now-detached element and do nothing.
const LECHYY_LOADED_ATTR = "data-lechyy-loaded";
const RUBY_SELECTOR = "ruby[data-word]";
let hoverListenersAttached = false;

if (document.documentElement.hasAttribute(LECHYY_LOADED_ATTR)) {
  // Reinjection: clean up existing tooltip from a previous script run.
  destroyTooltip();
  // Reset module-level state so subsequent calls behave as a fresh load.
  hoverListenersAttached = false;
}
document.documentElement.setAttribute(LECHYY_LOADED_ATTR, "1");

const PENDING_ATTR = "data-hanzi-pending";

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

// Idle callback with graceful fallback. requestIdleCallback is gated behind
// a short setTimeout safety net because it can hang indefinitely in headless
// browsers, testing environments, or on very busy pages.
function idle(cb: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback;
  const cic = (globalThis as { cancelIdleCallback?: typeof cancelIdleCallback }).cancelIdleCallback;
  if (typeof ric === "function") {
    let fired = false;
    const id = ric(() => {
      if (fired) return;
      fired = true;
      cb();
    });
    setTimeout(() => {
      if (fired) return;
      fired = true;
      if (typeof cic === "function") cic(id);
      cb();
    }, 200);
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
//
// PENDING_ATTR guard: checked before the await to prevent duplicate annotation
// if the same span is re-queued (e.g., by a repeated collectTextNodes call or
// a future MutationObserver). If annotatePending itself is called twice on the
// same span, the second invocation returns immediately at the guard — the
// await on line 97 is the true work boundary, so the guard must be before it.
//
// DOM presence check: verifies the span is still in the document before
// awaiting. If the span was removed (SPA navigation, user leaves page), the
// annotation is skipped entirely so the floating idle callback doesn't mutate
// a detached tree, parse a stale text node, or leak the promise.
async function annotatePending(span: HTMLSpanElement): Promise<void> {
  if (!span.hasAttribute(PENDING_ATTR)) return; // already handled
  if (!span.parentNode) return; // removed from DOM — skip
  const textNode = span.firstChild;
  try {
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      await annotateTextNode(textNode as Text);
    }
    span.removeAttribute(PENDING_ATTR);
    while (span.firstChild) {
      span.parentNode!.insertBefore(span.firstChild, span);
    }
    span.parentNode!.removeChild(span);
  } catch {
    // Annotation failed — leave span wrapped with PENDING_ATTR so a future
    // collectTextNodes pass can pick it up and retry. The span is still in
    // the DOM so it will be unobserve'd by the IntersectionObserver.
  }
}

// Public entry for programmatic callers (tests, future re-runs). Returns the
// count of candidate text nodes found. Reads document.body at call time.
export async function runLensMode(): Promise<number> {
  if (!document.body) return 0;
  if (!pageHasChinese()) return 0;
  await ensureAnnotator();
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
        idle(() =>
          annotatePending(span).catch((err) =>
            console.error(
              "Lechyy: annotate failed:",
              err instanceof Error ? err.message : String(err),
            ),
          ),
        );
      }
    },
    { rootMargin: "200px" },
  );

  let queued = 0;
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
      idle(() =>
        annotatePending(span).catch((err) =>
          console.error(
            "Lechyy: annotate failed:",
            err instanceof Error ? err.message : String(err),
          ),
        ),
      );
      queued++;
    } else {
      io.observe(span);
    }
  }

  console.info(
    "Lechyy M2: lens mode started,",
    candidates.length,
    "candidate text nodes,",
    queued,
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
  runLensMode().catch((err) =>
    console.error(
      "Lechyy: lens mode init failed:",
      err instanceof Error ? err.message : String(err),
    ),
  );
}
