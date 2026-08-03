import { annotateTextSync, ensureAnnotator, markAnnotated } from "./annotator";
import { collectLeafBlocks, collectTextNodes, containsHanzi } from "./segmenter";
import { destroyTooltip, dismissHover, hideTooltip, onRubyHover, setInteractive } from "./tooltip";
import { getCustomTerms, isDomainAllowed } from "./dictionary";
import { attachMutationObserver } from "./mutation-observer";

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
  // Shift-hold sticky: if Shift is held, enable interactive mode so the
  // tooltip stays open for selection/copying.
  const me = e as MouseEvent;
  if (me.shiftKey) {
    setInteractive(true);
    return;
  }
  dismissHover();  // M4.7: invalidate in-flight lookups for this ruby
  hideTooltip();
}

// Sticky tooltip: when mode is active, the tooltip stays visible and text is
// selectable. It dismisses on Esc, clicking elsewhere, or when the pointer
// leaves the tooltip element itself (mouse target no longer related to ruby).
function handleStickyMouseOver(e: Event): void {
  // If pointer enters the tooltip element while Shift is held, keep it alive.
  const tooltip = document.querySelector('[data-hanzi="tooltip"]') as HTMLElement | null;
  if (tooltip && (e.target === tooltip || tooltip.contains(e.target as Node))) {
    setInteractive(true);
  }
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    hideTooltip();
    setInteractive(false);
    e.preventDefault();
  }
}

// Attach the delegated hover listeners once per page. Idempotent.
export function attachHoverListeners(): void {
  if (hoverListenersAttached) return;
  if (!document.body) return;
  document.body.addEventListener("mouseover", handleMouseOver);
  document.body.addEventListener("mouseout", handleMouseOut);
  document.body.addEventListener("mouseover", handleStickyMouseOver);
  document.addEventListener("keydown", handleKeyDown);
  hoverListenersAttached = true;
}

// M4.3 Bounded idle work: processes actions across requestIdleCallback slices.
// Honors timeRemaining() > 10ms gate; when RIC is unavailable falls back to
// setTimeout with a generous 50ms timeRemaining so the loop continues without
// stalling in headless/test environments. Returns when `action` returns false
// (all work consumed). Batch size is enforced by the caller (20 nodes/slice).
function idleWhile(
  action: (deadline: { timeRemaining(): number; didTimeout: boolean }) => boolean,
  _batchSize?: number,
): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback;

    const tick = (deadline: { timeRemaining(): number; didTimeout: boolean }) => {
      if (deadline.didTimeout || deadline.timeRemaining() > 10) {
        if (!action(deadline)) {
          resolve();
          return;
        }
      }
      if (ric) ric(tick);
      else setTimeout(() => tick({ timeRemaining: () => 50, didTimeout: false }), 0);
    };

    if (ric) ric(tick);
    else setTimeout(() => tick({ timeRemaining: () => 50, didTimeout: false }), 0);
  });
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
// Nodes are processed in bounded idle slices: up to 20 per requestIdleCallback
// tick, with a timeRemaining() > 10ms gate.
async function annotateBlock(
  block: Element,
  customTerms: readonly string[],
): Promise<void> {
  const candidates = collectTextNodes(block);
  if (candidates.length === 0) return;

  let idx = 0;
  await idleWhile(() => {
    let processed = 0;
    while (idx < candidates.length && processed < 20) {
      const { node } = candidates[idx++];
      const parent = node.parentNode;
      if (!parent) { processed++; continue; }
      try {
        const text = node.nodeValue ?? "";
        const frag = annotateTextSync(text, customTerms);
        parent.replaceChild(frag, node);
      } catch (err) {
        console.error("Lechyy: annotate failed:", err instanceof Error ? err.message : String(err));
      }
      processed++;
    }
    return idx < candidates.length;
  }, 20);
}

// Re-annotates after a MutationObserver enqueue. Works exactly like
// annotateBlock but marks the resulting ruby elements so the observer
// won't re-process them.
async function annotateBlockWithMarking(
  block: Element,
  customTerms: readonly string[],
): Promise<void> {
  await annotateBlock(block, customTerms);
  // Mark all ruby elements in this block as processed.
  const roubles = block.querySelectorAll("ruby[data-word]");
  for (const ruby of Array.from(roubles)) {
    markAnnotated(ruby);
  }
}

// Public entry for programmatic callers (tests, future re-runs). Returns the
// count of candidate block elements found. Reads document.body at call time.
// Fetches custom terms from chrome.storage.once on first call (M3.5).
export async function runLensMode(): Promise<number> {
  if (!document.body) return 0;

  // v2.0 per-domain allowlist: if lechyy.domains is set in storage and this
  // host isn't listed, exit before the CJK gate so no data-word rubies and no
  // dictionary fetches fire on unlisted domains.
  if (!(await isDomainAllowed())) return 0;

  if (!pageHasChinese()) return 0;
  await ensureAnnotator();

  // M3.5: fetch custom terms once upfront. Empty array is a no-op --
  // annotateTextSync/annotateText already treat [] as absent.
  const customTerms = await getCustomTerms();

  attachHoverListeners();

  // M4.4: Attach MutationObserver before first annotation so we don't miss
  // dynamically injected content.  The observer enqueues added subtrees for
  // annotation via the idle callback queue.
  function enqueueMutationAnnotate(el: Element, ct: readonly string[]): void {
    idle(() =>
      annotateBlockWithMarking(el, ct).catch((err) =>
        console.error(
          "Lechyy: annotate failed:",
          err instanceof Error ? err.message : String(err),
        ),
      ),
    );
  }
  attachMutationObserver(
    document.body,
    enqueueMutationAnnotate,
    Promise.resolve(customTerms as readonly string[]),
  );

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
          annotateBlockWithMarking(block, customTerms).catch((err) =>
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
        annotateBlockWithMarking(element, customTerms).catch((err) =>
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
