/**
 * 三方合并冲突解析与文本替换纯函数集。
 */

export type ConflictChoice = "ours" | "theirs" | "both-ours-first" | "both-theirs-first" | "base";

export interface TextSegment {
  kind: "text";
  content: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
}

export interface ConflictBlock {
  kind: "conflict";
  id: number;
  oursLabel: string;
  baseLabel: string | null;
  theirsLabel: string;
  oursText: string;
  baseText: string | null;
  theirsText: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export type ConflictSegment = TextSegment | ConflictBlock;

interface LineSpan {
  raw: string; // 不含行尾换行符
  eol: string; // "\r\n" | "\n" | ""
  start: number;
  end: number; // 含行尾换行符的结束偏移
  lineNo: number; // 1-based
}

function splitLineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let pos = 0;
  let lineNo = 1;
  while (pos < text.length) {
    const lf = text.indexOf("\n", pos);
    if (lf === -1) {
      const slice = text.slice(pos);
      const raw = slice.endsWith("\r") ? slice.slice(0, -1) : slice;
      spans.push({ raw, eol: "", start: pos, end: text.length, lineNo });
      break;
    }
    const hasCr = lf > pos && text[lf - 1] === "\r";
    const rawEnd = hasCr ? lf - 1 : lf;
    spans.push({
      raw: text.slice(pos, rawEnd),
      eol: hasCr ? "\r\n" : "\n",
      start: pos,
      end: lf + 1,
      lineNo,
    });
    pos = lf + 1;
    lineNo++;
  }
  return spans;
}

function joinSlice(
  text: string,
  spans: LineSpan[],
  fromIdx: number,
  toIdxExclusive: number,
): string {
  if (fromIdx >= toIdxExclusive) return "";
  return text.slice(spans[fromIdx].start, spans[toIdxExclusive - 1].end);
}

/**
 * 将工作区文本解析为普通文本段与冲突块交替序列（支持标准二段标记与 diff3 三段标记）。
 * 未闭合的冲突标记会保留为普通文本，避免丢失文件内容。
 */
export function parseConflictSegments(text: string): ConflictSegment[] {
  if (!text) return [];
  const spans = splitLineSpans(text);
  const segments: ConflictSegment[] = [];
  let plainStartIdx = 0;
  let conflictId = 0;
  let i = 0;

  const pushPlain = (fromIdx: number, toIdxExclusive: number) => {
    if (fromIdx >= toIdxExclusive) return;
    const startOffset = spans[fromIdx].start;
    const endOffset = spans[toIdxExclusive - 1].end;
    segments.push({
      kind: "text",
      content: text.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      startLine: spans[fromIdx].lineNo,
    });
  };

  while (i < spans.length) {
    if (!spans[i].raw.startsWith("<<<<<<<")) {
      i++;
      continue;
    }

    const startIdx = i;
    const oursLabel = spans[i].raw.slice(7).trim() || "Ours";
    let baseMarkerIdx: number | null = null;
    let sepIdx: number | null = null;
    let endIdx: number | null = null;

    let j = i + 1;
    while (j < spans.length) {
      const line = spans[j].raw;
      if (line.startsWith("<<<<<<<")) {
        // 遇到新的嵌套/未闭合开始标记，放弃前一段从 startIdx 当作普通文本继续
        break;
      }
      if (sepIdx === null && baseMarkerIdx === null && line.startsWith("|||||||")) {
        baseMarkerIdx = j;
      } else if (sepIdx === null && line.startsWith("=======")) {
        sepIdx = j;
      } else if (sepIdx !== null && line.startsWith(">>>>>>>")) {
        endIdx = j;
        break;
      }
      j++;
    }

    if (sepIdx === null || endIdx === null) {
      i++;
      continue;
    }

    pushPlain(plainStartIdx, startIdx);

    const oursStart = startIdx + 1;
    const oursEnd = baseMarkerIdx !== null ? baseMarkerIdx : sepIdx;
    const baseLabel =
      baseMarkerIdx !== null ? spans[baseMarkerIdx].raw.slice(7).trim() || "Base" : null;
    const baseText =
      baseMarkerIdx !== null ? joinSlice(text, spans, baseMarkerIdx + 1, sepIdx) : null;
    const theirsLabel = spans[endIdx].raw.slice(7).trim() || "Theirs";

    segments.push({
      kind: "conflict",
      id: conflictId++,
      oursLabel,
      baseLabel,
      theirsLabel,
      oursText: joinSlice(text, spans, oursStart, oursEnd),
      baseText,
      theirsText: joinSlice(text, spans, sepIdx + 1, endIdx),
      startOffset: spans[startIdx].start,
      endOffset: spans[endIdx].end,
      startLine: spans[startIdx].lineNo,
      endLine: spans[endIdx].lineNo,
    });

    i = endIdx + 1;
    plainStartIdx = i;
  }

  pushPlain(plainStartIdx, spans.length);
  return segments;
}

/** 统计文本中完整的冲突块数量。 */
export function countConflictBlocks(text: string): number {
  return parseConflictSegments(text).filter((s) => s.kind === "conflict").length;
}

/** 检测文本中是否仍残留未解决的冲突标记（含完整块或残余起始/结束行）。 */
export function hasConflictMarkers(text: string): boolean {
  if (countConflictBlocks(text) > 0) return true;
  return /^<{7}(?:\s|$)|^>{7}(?:\s|$)/m.test(text);
}

/** 根据用户选择构造替换文本。 */
export function replacementForChoice(block: ConflictBlock, choice: ConflictChoice): string {
  switch (choice) {
    case "ours":
      return block.oursText;
    case "theirs":
      return block.theirsText;
    case "base":
      return block.baseText ?? "";
    case "both-ours-first":
      return combineBranches(block.oursText, block.theirsText);
    case "both-theirs-first":
      return combineBranches(block.theirsText, block.oursText);
  }
}

function combineBranches(first: string, second: string): string {
  if (!first) return second;
  if (!second) return first;
  if (first.endsWith("\n") || first.endsWith("\r")) {
    return `${first}${second}`;
  }
  const eol = first.includes("\r\n") || second.includes("\r\n") ? "\r\n" : "\n";
  return `${first}${eol}${second}`;
}

/** 在原文中替换单个冲突块。 */
export function applyConflictChoice(
  text: string,
  block: ConflictBlock,
  choice: ConflictChoice,
): string {
  const replacement = replacementForChoice(block, choice);
  return `${text.slice(0, block.startOffset)}${replacement}${text.slice(block.endOffset)}`;
}

/** 批量应用同一策略解决全部冲突块（从后往前替换以保持偏移有效）。 */
export function resolveAllConflictBlocks(text: string, choice: ConflictChoice): string {
  const blocks = parseConflictSegments(text).filter(
    (s): s is ConflictBlock => s.kind === "conflict",
  );
  if (blocks.length === 0) return text;
  let next = text;
  for (let i = blocks.length - 1; i >= 0; i--) {
    next = applyConflictChoice(next, blocks[i], choice);
  }
  return next;
}
