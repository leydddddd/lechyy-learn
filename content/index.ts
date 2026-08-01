import { annotateTextNode, ensureAnnotator } from "./annotator";
import { collectLeafBlocks, collectTextNodes, containsHanzi } from "./segmenter";
import { destroyTooltip, hideTooltip, onRubyHover } from "./tooltip";
import { getCustomTerms } from "./dictionary";

// Reinjection guard (0.4): mark that this script has loaded. On reinject, clean
// up any pre-existing tooltip node.  Residual event-listener closures from older
// script instances are impossible to remove (addEventListener has no
// "unregister-all" API), so we make them harmless -- their closures reference a
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

// Annotate all CJK text nodes inside a block-level element that just entered
// the viewport. This replaces the old wrapper-based approach: instead of
// wrapping every text node at startup (N DOM mutations for N text nodes), we
// watch the block element itself and only walk its descendants on intersection.
async function annotateBlock(
  block: Element,
  customTerms: readonly string[],
): Promise<void> {
  const candidates = collectTextNodes(block);
  if (candidates.length === 0) return;
  for (const { node } of candidates) {
    try {
      await annotateTextNode(node, customTerms);
    } catch (err) {
      console.error("Lechyy: annotate failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

// Public entry for programmatic callers (tests, future re-runs). Returns the
// count of candidate block elements found. Reads document.body at call time.
// Fetches custom terms from chrome.storage.once on first call (M3.5).
export async function runLensMode(): Promise<number> {
  if (!document.body) return 0;
  if (!pageHasChinese()) return 0;
  await ensureAnnotator();

  // M3.5: fetch custom terms once upfront. Empty array is a no-op --
  // annotateTextSync/annotateText already treat [] as absent.
  const customTerms = await getCustomTerms();

  attachHoverListeners();

  // Collect leaf block elements containing CJK. On intersection, we walk only
  // that block's descendants for annotation -- no upfront per-text-node wrappers.
  const blocks = collectLeafBlocks(document.body);
  if (blocks.length === 0) return 0;

  const handled = new WeakSet<Element>();
  let queued = 0;

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const block = entry.target as Element;
        io.unobserve(block);
        handled.add(block);
        idle(() =>
          annotateBlock(block, customTerms).catch((err) =>
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

  for (const { element } of blocks) {
    if (handled.has(element)) continue;
    handled.add(element);
    // If already in viewport on first pass, annotate now rather than waiting
    // for an IO fire-and-observe round-trip.
    const rect = element.getBoundingClientRect();
    const inView =
      rect.bottom > -1 &&
      rect.top < (globalThis.innerHeight ?? 1) + 1;
    if (inView) {
      idle(() =>
        annotateBlock(element, customTerms).catch((err) =>
          console.error(
            "Lechyy: annotate failed:",
            err instanceof Error ? err.message : String(err),
          ),
        ),
      );
      queued++;
    } else {
      io.observe(element);
    }
  }

  console.info(
    "Lechyy M4.1: element-level lens mode started,",
    blocks.length,
    "block targets,",
    queued,
    "annotated immediately",
  );
  return blocks.length;
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
