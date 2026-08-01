// Pure helpers + DOM walker. The two halves are kept together because the
// "is this text CJK?" filter and the "skip these tags" filter share state.

export const TONE_VOWELS: Record<string, number> = {
  ā: 1, ē: 1, ī: 1, ō: 1, ū: 1, ǖ: 1,
  á: 2, é: 2, í: 2, ó: 2, ú: 2, ǘ: 2,
  ǎ: 3, ě: 3, ǐ: 3, ǒ: 3, ǔ: 3, ǚ: 3,
  à: 4, è: 4, ì: 4, ò: 4, ù: 4, ǜ: 4,
};

export function toneClass(py: string): string {
  for (const ch of py) {
    const tone = TONE_VOWELS[ch];
    if (tone) return `tone-${tone}`;
  }
  return "tone-1";
}

export const HANZI_RE = /[\u4e00-\u9fff]/;

export function containsHanzi(s: string): boolean {
  return HANZI_RE.test(s);
}

// Tags whose subtree we never descend into. Add `ruby` so we don't re-process
// already-annotated text (the <rb> holds the original hanzi).
export const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "INPUT",
  "TEXTAREA",
  "CODE",
  "PRE",
  "RUBY",
  "RP",
  "RT",
  "SELECT",
  "OPTION",
  "BUTTON",
  "NOSCRIPT",
  "TEMPLATE",
]);

export interface CollectedTextNode {
  node: Text;
  text: string;
}

export interface CollectedBlock {
  element: Element;
  text: string;
}

// Block-level leaf elements that should be observed by IntersectionObserver.
// We avoid observing everything — only elements that can contain text content
// and have no sibling text nodes (pure leaf). This keeps the IO entry count
// proportional to visible paragraphs/lines, not to individual text nodes.
const OBSERVABLE_BLOCK_TAG = new Set([
  "P", "LI", "DIV", "TD", "TH", "CAPTION",
  "H1", "H2", "H3", "H4", "H5", "H6",
  "SPAN", "A", "LABEL", "FIGCAPTION", "LEGEND",
  "BLOCKQUOTE", "DT", "DD", "OPTION", "PRE",
  "CODE", "VAR", "SAMP", "KBD", "MARK",
]);

// Ancestors that make an element an editing surface — skip those text nodes
// entirely so we don't corrupt live drafts in Notion-style editors.
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

// Walks `root` for text nodes containing at least one CJK ideograph, skipping
// subtrees under SKIP_TAGS. Returns a flat array of { node, text }. Pure w.r.t.
// the DOM: it does not mutate.
export function collectTextNodes(root: Node): CollectedTextNode[] {
  const ownerDocument =
    root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  if (!ownerDocument) return [];

  const walker = ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(candidate) {
        if (candidate.nodeType === Node.ELEMENT_NODE) {
          const el = candidate as Element;
          if (SKIP_TAGS.has(el.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (isEditingSurface(el)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        if (candidate.nodeType === Node.TEXT_NODE) {
          // Inline guard: skip text owned by any editing-surface ancestor.
          let anc: Node | null = candidate.parentNode;
          while (anc && anc !== root) {
            if (anc.nodeType === Node.ELEMENT_NODE && isEditingSurface(anc as Element)) {
              return NodeFilter.FILTER_REJECT;
            }
            anc = anc.parentNode;
          }
          const text = (candidate as Text).nodeValue ?? "";
          return containsHanzi(text)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  const out: CollectedTextNode[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      const text = (current as Text).nodeValue ?? "";
      if (containsHanzi(text)) {
        out.push({ node: current as Text, text });
      }
    }
    current = walker.nextNode();
  }
  return out;
}

// Collect leaf block elements containing CJK for IntersectionObserver targets.
// Instead of wrapping every text node, this finds block/leaf elements whose
// combined textContent contains at least one CJK ideograph. These elements
// serve as IO targets — on intersection, the caller walks the block's
// descendants with collectTextNodes() and annotates only those.
//
// A candidate element passes if:
// 1. It is a leaf (no block-level children that themselves contain CJK).
// 2. It contains CJK in its textContent.
// 3. It is not inside SKIP_TAGS or an editing surface.
// 4. It does not already contain a <ruby[data-word]> descendant (already annotated).
//
// This eliminates the N wrapper-insertion cost on startup. The IO fires per
// block element, not per text node. For a 100k-char page with ~500 paragraphs,
// that's ~500 IO entries instead of potentially tens of thousands of spans.
export function collectLeafBlocks(root: Node): CollectedBlock[] {
  const ownerDocument =
    root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  if (!ownerDocument) return [];

  const results: CollectedBlock[] = [];

  // First pass: find all block-level elements that could be IO targets.
  // We traverse manually to handle leaf-detection properly.
  function walk(node: Node, insideSkip: boolean): void {
    if (node.nodeType === Node.COMMENT_NODE) return;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const tagName = el.tagName;

      // Hard skip: never descend into these subtrees
      if (SKIP_TAGS.has(tagName)) return;

      // Editing surface: skip
      if (!insideSkip && isEditingSurface(el)) {
        // Still descend into inline children inside an editing surface
        // to find any non-editable descendants, but skip the surface itself.
        // Actually, once we hit an editing surface, we skip the whole subtree.
        return;
      }

      // Already annotated: skip (its descendants are either text or ruby elements)
      if (el.querySelector && el.querySelector("ruby[data-word]")) {
        return;
      }

      const isSkipTag = insideSkip || SKIP_TAGS.has(tagName);

      // Check if this is an observable block element
      const isObservable = OBSERVABLE_BLOCK_TAG.has(tagName);

      if (isObservable) {
        // Check if it has block-level children (descendants that could themselves be targets)
        // Block-level: div, p, pre, h1-h6, ul, ol, li, table cells, blockquote, etc.
        const hasBlockChildren = Array.from(el.children).some(
          (child) => isBlockElement(child as Element) && !SKIP_TAGS.has(child.tagName),
        );

        if (hasBlockChildren) {
          // Not a leaf — recurse into children (but not the block container itself)
          for (const child of el.childNodes) {
            walk(child, isSkipTag);
          }
        } else if (containsHanzi(el.textContent ?? "")) {
          // This is a potential leaf — check if it contains CJK
          results.push({ element: el, text: el.textContent ?? "" });
        }
      } else {
        // Not an observable block tag — recurse into children
        for (const child of el.childNodes) {
          walk(child, isSkipTag);
        }
      }
    }
  }

  walk(root, false);
  return results;
}

// Check if an element is block-level (should not be a child-of-another-observable)
function isBlockElement(el: Element): boolean {
  const tagName = el.tagName;
  return new Set([
    "DIV", "P", "PRE", "H1", "H2", "H3", "H4", "H5", "H6",
    "UL", "OL", "LI", "TABLE", "TR", "TD", "TH", "THEAD", "TBODY",
    "TFOOT", "BLOCKQUOTE", "DL", "DT", "DD", "SECTION", "ARTICLE",
    "ASIDE", "HEADER", "FOOTER", "MAIN", "NAV", "FIGURE", "ADDRESS", "HR", "BR",
  ]).has(tagName);
}
