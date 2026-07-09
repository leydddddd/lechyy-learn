import { pinyin } from "pinyin-pro";
import { containsHanzi, toneClass } from "../content/segmenter";

function annotate(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const array = pinyin(src, { type: "array" }) as string[];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!containsHanzi(ch)) {
      frag.appendChild(document.createTextNode(ch));
      continue;
    }
    const py = array[i] ?? "";
    const ruby = document.createElement("ruby");
    ruby.setAttribute("data-word", ch);
    const rb = document.createElement("rb");
    rb.textContent = ch;
    const rt = document.createElement("rt");
    rt.textContent = py;
    rt.classList.add(toneClass(py));
    ruby.appendChild(rb);
    ruby.appendChild(rt);
    frag.appendChild(ruby);
  }
  return frag;
}

function run(): void {
  const templates = document.querySelectorAll<HTMLTemplateElement>(
    "[data-annotate]",
  );
  if (templates.length === 0) {
    console.warn("Lechyy M1: no annotation targets found");
    return;
  }
  for (const tpl of templates) {
    const src =
      tpl instanceof HTMLTemplateElement
        ? tpl.content.textContent ?? ""
        : tpl.textContent ?? "";
    if (!containsHanzi(src)) continue;
    const frag = annotate(src);
    const host = tpl.parentElement;
    if (host) {
      host.appendChild(frag);
      tpl.remove();
    }
  }
  console.info(
    "Lechyy M1: annotated",
    templates.length,
    "templates,",
    document.querySelectorAll("ruby[data-word]").length,
    "ruby nodes",
  );
}

run();
