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
