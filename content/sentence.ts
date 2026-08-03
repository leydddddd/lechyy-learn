import type { CollectedBlock } from "./segmenter";

export interface Sentence {
  text: string;
  blockIndex: number;
  startOffset: number;
  endOffset: number;
}

const SENTENCE_END_RE = /[。！？；\n]/;

function isPairOpen(ch: string): boolean {
  return ch === "（" || ch === "(" || ch === "[" || ch === "{" || ch === "「" || ch === "『" || ch === "【";
}

function isPairClose(ch: string): boolean {
  return ch === "）" || ch === ")" || ch === "]" || ch === "}" || ch === "」" || ch === "』" || ch === "】";
}

const OPEN_MAP: Record<string, string> = {
  "（": "）", "(": ")", "[": "]", "{": "}",
  "「": "」", "『": "』", "【": "】",
};

function splitSentences(text: string): { text: string; startOffset: number; endOffset: number }[] {
  const result: { text: string; startOffset: number; endOffset: number }[] = [];
  const stack: string[] = [];
  let segStart = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (isPairOpen(ch)) {
      stack.push(OPEN_MAP[ch] ?? ch);
    } else if (isPairClose(ch)) {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }

    if (stack.length === 0 && SENTENCE_END_RE.test(ch)) {
      result.push({
        text: text.slice(segStart, i + 1),
        startOffset: segStart,
        endOffset: i + 1,
      });
      segStart = i + 1;
    }
  }

  if (segStart < text.length) {
    result.push({
      text: text.slice(segStart),
      startOffset: segStart,
      endOffset: text.length,
    });
  }

  return result;
}

export function extractArticle(blocks: CollectedBlock[]): Sentence[] {
  if (blocks.length === 0) return [];

  const contentBlockCounts: { blockIndex: number; nonEmptyParagraphs: number }[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const trimmed = blocks[i].text.trim();
    if (trimmed.length > 0) {
      contentBlockCounts.push({ blockIndex: i, nonEmptyParagraphs: 1 });
    }
  }

  if (contentBlockCounts.length === 0) return [];

  let bestStart = 0;
  let bestLen = 0;
  let curStart = contentBlockCounts[0].blockIndex;
  let curLen = 1;
  const gapThreshold = 3;

  for (let i = 1; i < contentBlockCounts.length; i++) {
    const gap = contentBlockCounts[i].blockIndex - contentBlockCounts[i - 1].blockIndex;
    if (gap <= gapThreshold) {
      curLen++;
    } else {
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
      curStart = contentBlockCounts[i].blockIndex;
      curLen = 1;
    }
  }
  if (curLen >= bestLen) {
    bestLen = curLen;
    bestStart = curStart;
  }

  const clusterStart = bestStart;
  const clusterEnd = Math.min(clusterStart + bestLen + gapThreshold, blocks.length);

  const sentences: Sentence[] = [];

  for (let bi = clusterStart; bi < clusterEnd; bi++) {
    const text = blocks[bi].text;
    const splits = splitSentences(text);
    for (const seg of splits) {
      if (seg.text.trim().length > 0) {
        sentences.push({
          text: seg.text,
          blockIndex: bi,
          startOffset: seg.startOffset,
          endOffset: seg.endOffset,
        });
      }
    }
  }

  return sentences;
}