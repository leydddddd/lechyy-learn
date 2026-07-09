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
export function annotateText(src: string): DocumentFragment {
  initAnnotator();
  const frag = document.createDocumentFragment();
  const words = segmentIntoWords(src);

  for (const word of words) {
    const hanziChars = word.filter((c) => containsHanzi(c.origin));
    if (hanziChars.length === 0) {
      // Pure non-hanzi token: join chars back into the original string and emit
      // as a single text node to preserve spacing/punctuation exactly.
      frag.appendChild(document.createTextNode(word.map((c) => c.origin).join("")));
      continue;
    }

    const ruby = document.createElement("ruby");
    ruby.setAttribute("data-word", word.map((c) => c.origin).join(""));
    ruby.setAttribute("data-hanzi-source", word.map((c) => c.origin).join(""));

    for (const c of word) {
      if (!containsHanzi(c.origin)) {
        // Non-hanzi char inside an otherwise-hanzi token edge case — emit as
        // plain text between rb groups, still inside the ruby so layout flows.
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
  return frag;
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
