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
// already-annotated text (the <rb> holds the original hanzi). The
// data-hanzi-annotated attribute on a parent is a second guard for nodes we
// replaced with a fragment.
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

export const ANNOTATED_ATTR = "data-hanzi-annotated";

export interface CollectedTextNode {
  node: Text;
  text: string;
}

// Walks `root` for text nodes containing at least one CJK ideograph, skipping
// subtrees under SKIP_TAGS and subtrees already marked annotated. Returns a
// flat array of { node, text }. Pure w.r.t. the DOM: it does not mutate.
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
          if (el.hasAttribute && el.hasAttribute(ANNOTATED_ATTR)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        if (candidate.nodeType === Node.TEXT_NODE) {
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
