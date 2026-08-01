import { annotatedNodes } from "./annotator";
import { containsHanzi } from "./segmenter";

/**
 * M4.4: Batched MutationObserver for dynamic content.
 *
 * Attaches before the first annotation pass so no newly injected text
 * nodes are missed.  Ignores mutations inside Lechyy's own ruby markup
 * (target.closest("[data-word]") is the cheap skip check).  Enqueues
 * only added subtrees for annotation via the idle queue in the index
 * module, avoiding duplicate work when the DOM walker also revisits
 * the same element.
 *
 * Returned observer can be disconnected to shut down annotation of
 * dynamic content (e.g. user toggles extension off).
 */

interface AnnotatePendingFn {
  (element: Element, customTerms: readonly string[]): void;
}

// Numeric node type constants (avoid referencing `Node` global which
// may not exist in jsdom during MutationObserver callbacks).
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const ELEMENT_NODE = 1;

const RUBY_SELECTOR = "ruby[data-word]";

/**
 * Check whether a DOM node belongs inside Lechyy's own annotated ruby
 * markup.  Uses `closest("[data-word]")` as the cheap O(1) heuristic:
 * if the target (or a descendant causing the mutation) is a child of a
 * ruby element we created, ignore it.
 */
function isOwnMutation(node: Node): boolean {
  return annotatedNodes.has(node) || closestRubyInsideAnnotated(node) !== null;
}

function closestRubyInsideAnnotated(node: Node): Element | null {
  if (node.nodeType === ELEMENT_NODE) {
    const el = node as Element;
    const ruby = el.closest(RUBY_SELECTOR);
    if (ruby) return ruby;
    if (annotatedNodes.has(el)) return el as Element;
  }
  return null;
}

/**
 * Collect candidate elements from a subtree for annotation: leaf block
 * elements (paragraphs, divs, spans…) whose textContent contains CJK
 * and that have NOT been annotated yet (no descendant ruby[data-word]).
 *
 * Skips editing surfaces, SKIP_TAGS subtrees, and already-annotated
 * branches.  Returns elements suitable for the idle-annotation loop
 * in index.ts.
 */
function collectPendingFromSubtree(root: Node): Element[] {
  const pending: Element[] = [];

  function walk(node: Node): void {
    if (node.nodeType === COMMENT_NODE) return;

    if (node.nodeType === ELEMENT_NODE) {
      const el = node as Element;

      // Already annotated? Skip entire subtree.
      if (el.querySelector(RUBY_SELECTOR)) return;

      // Editing surfaces?  Same rules as segmenter.ts.
      if (isEditingSurface(el)) return;

      // SKIP_TAGS?
      if (SKIP_TAGS.has(el.tagName)) return;

      // Leaf check: does this element directly contain CJK text in
      // its non-ruby descendants?
      const text = getVisibleTextContent(el);
      if (containsHanzi(text) && isLeafElement(el)) {
        pending.push(el);
        return;
      }

      // Not a leaf — descend
      for (const child of el.childNodes) {
        walk(child);
      }
    }
  }

  walk(root);
  return pending;
}

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "INPUT", "TEXTAREA", "CODE", "PRE", "RUBY",
  "RP", "RT", "SELECT", "OPTION", "BUTTON", "NOSCRIPT", "TEMPLATE",
]);

const OBSERVABLE_BLOCK_TAG = new Set([
  "P", "LI", "DIV", "TD", "TH", "CAPTION",
  "H1", "H2", "H3", "H4", "H5", "H6",
  "SPAN", "A", "LABEL", "FIGCAPTION", "LEGEND",
  "BLOCKQUOTE", "DT", "DD", "OPTION", "PRE",
  "CODE", "VAR", "SAMP", "KBD", "MARK",
]);

function isEditingSurface(el: Element): boolean {
  if (el.hasAttribute && el.hasAttribute("contenteditable")) {
    const v = el.getAttribute("contenteditable");
    return v === null || !["false", "inherit", "plaintext-only"].includes(v);
  }
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.hasAttribute && el.hasAttribute("aria-hidden")) return true;
  if (el.hasAttribute && el.hasAttribute("inert")) return true;
  return false;
}

function isLeafElement(el: Element): boolean {
  // A leaf block has no block-level children that could themselves be targets
  for (const child of el.children) {
    const ch = child as Element;
    if (OBSERVABLE_BLOCK_TAG.has(ch.tagName)) return false;
  }
  return true;
}

/**
 * Get text content of an element, excluding ruby (data-word) subtrees
 * that we've already annotated.  This prevents re-annotation of the
 * same text through the ruby <rb> child.
 */
function getVisibleTextContent(el: Element): string {
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      text += (child as Text).nodeValue ?? "";
    } else if (child.nodeType === ELEMENT_NODE) {
      const ch = child as Element;
      if (ch.closest(RUBY_SELECTOR)) continue;
      text += ch.textContent ?? "";
    }
  }
  return text;
}

/**
 * Start observing `rootEl` for DOM mutations.  When unowned elements
 * with CJK text are added, enqueue them for annotation via
 * `onAnnotatePending`.
 *
 * `onAnnotatePending` is a callback from index.ts that wraps the real
 * annotateBlock in an idle callback, so the observer stays decoupled
 * from the actual annotation logic.
 *
 * The observer is set up with childList and characterData subtree
 * flags.  characterData is needed because sites may also mutate text
 * content in-place (textContent setter, framework updates) rather
 * than inserting new nodes.
 */
export function attachMutationObserver(
  rootEl: Node,
  onAnnotatePending: AnnotatePendingFn,
  customTermsPromise: PromiseLike<readonly string[]>,
): MutationObserver {
  const observer = new MutationObserver(
    (mutations) => {
      // Batch all mutations in this batch, then enqueue work once.
      // Process mutations synchronously to collect all pending elements.
      const pending = new Set<Element>();

      for (const mutation of mutations) {
        // Skip our own mutations (inside ruby[data-word] elements)
        if (mutation.target.nodeType === ELEMENT_NODE) {
          const el = mutation.target as Element;
          if (isOwnMutation(el)) continue;
        }

        // For added nodes: inspect each added subtree
        for (const addedNode of mutation.addedNodes) {
          if (isOwnMutation(addedNode)) continue;

          if (addedNode.nodeType === ELEMENT_NODE) {
            const el = addedNode as Element;
            // If this element itself contains CJK, enqueue it directly
            if (containsHanzi(el.textContent ?? "")) {
              // Check if it has its own ruby — skip subtrees we already annotated
              if (el.querySelector(RUBY_SELECTOR)) continue;
              // Enqueue leaf candidates from this subtree
              const candidates = collectPendingFromSubtree(el);
              for (const c of candidates) pending.add(c);
            }
            // If the element has block-level children, also walk them
            // for added text nodes (e.g. framework-rendered paragraphs)
            for (const child of el.childNodes) {
              if (child.nodeType === ELEMENT_NODE) {
                if (isOwnMutation(child)) continue;
                if (containsHanzi((child as Element).textContent ?? "")) {
                  const innerCandidates = collectPendingFromSubtree(child as Element);
                  for (const c of innerCandidates) pending.add(c);
                }
              }
            }
          }
        }

        // For characterData changes: the text content changed in place.
        // Only proceed if the target is a text node or has CJK text.
        if (mutation.type === "characterData") {
          const target = mutation.target;
          if (target.nodeType === TEXT_NODE) {
            const text = (target as Text).nodeValue ?? "";
            if (containsHanzi(text)) {
              const parent = target.parentNode;
              if (parent && parent.nodeType === ELEMENT_NODE) {
                const candidate = findLeafBlockAncestor(parent as Element);
                if (candidate && !candidate.querySelector(RUBY_SELECTOR)) {
                  pending.add(candidate);
                }
              }
            }
          }
        }
      }

      // Enqueue all pending elements for annotation
      if (pending.size > 0) {
        Promise.resolve(customTermsPromise).then((customTerms) => {
          for (const el of pending) {
            onAnnotatePending(el, customTerms);
          }
        }).catch((err) => {
          console.error(
            "Lechyy: mutation-observer fetch custom terms failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    },
  );

  observer.observe(rootEl, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: false,
  });

  console.info("Lechyy M4.4: MutationObserver attached to dynamic content");
  return observer;
}

/**
 * Find the leaf-block ancestor of a node, or the node itself if it
 * qualifies as a leaf block.  Used when a text node's content changes
 * to enqueue the smallest possible element for re-annotation.
 */
function findLeafBlockAncestor(el: Element): Element | null {
  let current: Element | null = el;

  // Walk up at most 10 ancestors to avoid scanning the entire DOM.
  let depth = 0;
  while (current && depth < 10) {
    if (OBSERVABLE_BLOCK_TAG.has(current.tagName) && !isEditingSurface(current)) {
      // Check if it contains CJK
      if (containsHanzi(current.textContent ?? "")) {
        return current;
      }
    }
    current = current.parentElement;
    depth++;
  }
  return null;
}
