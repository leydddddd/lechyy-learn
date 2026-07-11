import { addDict, OutputFormat, segment } from "pinyin-pro";
import CompleteDict from "@pinyin-pro/data/complete";

import { ANNOTATED_ATTR, containsHanzi, toneClass } from "./segmenter";

let dictLoaded = false;

// Idempotent: call once per content-script lifetime before annotating.
export function initAnnotator(): void {
  if (dictLoaded) return;
  addDict(CompleteDict);
  dictLoaded = true;
}

interface CharInfo {
  origin: string;
  pinyin: string;
}

// Pre-split a string on user-defined custom terms. Terms must be sorted
// longest-first (getCustomTerms() already provides this order). Greedy
// left-to-right: for each position, try the longest matching term first, then
// shorter terms, then fall through to a single character. Non-CJK characters
// are always emitted as single-character segments.
//
// Returns segments: each is either a custom term string (present in terms) or
// a plain substring that pinyin-pro should segment normally. Custom terms are
// guaranteed to contain CJK (the storage guard ensures keys are meaningful).
// Pure — exported for tests.
export function applyCustomSegments(
  text: string,
  terms: readonly string[],
): string[] {
  const segments: string[] = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const term of terms) {
      if (text.startsWith(term, i)) {
        segments.push(term);
        i += term.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      segments.push(text[i]);
      i++;
    }
  }
  return segments;
}

// Segment once and cache the AllArray structure. Each outer element is a word
// (one or more chars); we keep chars grouped for the per-word <ruby> + per-char
// <rb>/<rt> rendering.
function segmentIntoWords(text: string): CharInfo[][] {
  const result = segment(text, { format: OutputFormat.AllArray }) as Array<
    Array<{ origin: string; result: string }>
  >;
  return result.map((word) =>
    word.map((c) => ({ origin: c.origin, pinyin: c.result })),
  );
}

// Build a DocumentFragment that mirrors `src` but with every run of hanzi
// (within a word) wrapped in <ruby data-word="...">...<rb>...<rt class="tone-N">...
// </rt>...</ruby>. Non-hanzi tokens (punctuation, Latin, numbers) are emitted as
// plain text nodes to preserve the original layout exactly.
// Marks the ruby element with data-hanzi-source so future revert logic has the
// original text available; marks the parent with data-hanzi-annotated after the
// caller replaces the node.
//
// If `customTerms` is provided, the text is pre-split on user-defined terms
// (longest-match first) before the general segmenter. Custom terms are rendered
// as a single ruby element with the user's pinyin from the dictionary (via
// lookup) rather than pinyin-pro's output. Omit `customTerms` for unchanged
// behavior (or pass an empty array).
export function annotateText(
  src: string,
  customTerms?: readonly string[],
): DocumentFragment {
  initAnnotator();
  const frag = document.createDocumentFragment();

  const terms = customTerms && customTerms.length > 0 ? customTerms : undefined;

  if (terms) {
    const segments = applyCustomSegments(src, terms);
    for (const segment of segments) {
      if (terms.includes(segment)) {
        // Custom term: render as a single ruby with per-char pinyin from
        // pinyin-pro. We segment for per-char data but emit one ruby element.
        _appendCustomTerm(frag, segment);
      } else {
        // Non-custom: normal pinyin-pro segmentation.
        _appendWords(frag, segmentIntoWords(segment));
      }
    }
  } else {
    _appendWords(frag, segmentIntoWords(src));
  }
  return frag;
}

// Render a custom term as a single ruby element with per-character pinyin.
function _appendCustomTerm(frag: DocumentFragment, term: string): void {
  const chars = segmentIntoWords(term);
  // Flatten all words (pinyin-pro may group multi-char, but for a term we
  // want one ruby). Each char gets rb+rt.
  const allChars = chars.flat();
  const hanziChars = allChars.filter((c) => containsHanzi(c.origin));
  if (hanziChars.length === 0) {
    frag.appendChild(document.createTextNode(term));
    return;
  }

  const ruby = document.createElement("ruby");
  ruby.setAttribute("data-word", term);
  ruby.setAttribute("data-hanzi-source", term);

  for (const c of allChars) {
    if (!containsHanzi(c.origin)) {
      ruby.appendChild(document.createTextNode(c.origin));
      continue;
    }
    const rb = document.createElement("rb");
    rb.textContent = c.origin;
    const rt = document.createElement("rt");
    rt.textContent = c.pinyin;
    rt.classList.add(toneClass(c.pinyin));
    ruby.appendChild(rb);
    ruby.appendChild(rt);
  }
  frag.appendChild(ruby);
}

function _appendWords(frag: DocumentFragment, words: CharInfo[][]): void {
  for (const word of words) {
    const hanziChars = word.filter((c) => containsHanzi(c.origin));
    if (hanziChars.length === 0) {
      frag.appendChild(document.createTextNode(word.map((c) => c.origin).join("")));
      continue;
    }

    const ruby = document.createElement("ruby");
    ruby.setAttribute("data-word", word.map((c) => c.origin).join(""));
    ruby.setAttribute("data-hanzi-source", word.map((c) => c.origin).join(""));

    for (const c of word) {
      if (!containsHanzi(c.origin)) {
        ruby.appendChild(document.createTextNode(c.origin));
        continue;
      }
      const rb = document.createElement("rb");
      rb.textContent = c.origin;
      const rt = document.createElement("rt");
      rt.textContent = c.pinyin;
      rt.classList.add(toneClass(c.pinyin));
      ruby.appendChild(rb);
      ruby.appendChild(rt);
    }
    frag.appendChild(ruby);
  }
}

// Replace a Text node with the annotated fragment and mark the parent as
// processed so collectTextNodes skips it on later runs. Returns the ruby
// elements inserted (for the caller to wire hover handlers in M3).
export function annotateTextNode(node: Text): Element[] {
  const parent = node.parentNode;
  if (!parent) return [];
  const text = node.nodeValue ?? "";
  const frag = annotateText(text);
  const inserted: Element[] = [];
  for (const child of Array.from(frag.children)) {
    if (child.tagName === "RUBY") inserted.push(child);
  }
  parent.replaceChild(frag, node);
  if (parent.nodeType === Node.ELEMENT_NODE) {
    (parent as Element).setAttribute(ANNOTATED_ATTR, "1");
  }
  return inserted;
}
