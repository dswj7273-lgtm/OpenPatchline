/**
 * Diff 网格纯计算辅助函数：统一视图行拆解、视觉列宽计算、可视窗口与变更导航定位。
 *
 * 与 DOM / React 解耦，供 SplitDiffGrid / UnifiedGrid 与单元测试共同复用。
 */

import type { AlignedRow, DiffLineSelection, PatchSide, RowCell } from "../../types";

/** 统一视图的单行：旧 / 新行号 + 内容。 */
export interface UnifiedLine {
  oldNo: number | null;
  newNo: number | null;
  cell: RowCell;
  /** 源 AlignedRow 下标（token 查找用）。 */
  rowIndex: number;
  side: "old" | "new";
  /** 折叠占位行（v0.6 / 6.5）：不渲染代码，仅展示展开入口。 */
  fold?: {
    foldIndex: number;
    hiddenCount: number;
    fromLineNo: number | null;
    toLineNo: number | null;
  };
}

/** 估算单行视觉列数（Tab 计 4 列，宽字符 / 中文计 2 列，ASCII 计 1 列）。 */
export function visualCols(text: string): number {
  let cols = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9) cols += 4;
    else if (code > 0xff) cols += 2;
    else cols += 1;
  }
  return cols;
}

/** 某一侧（或两侧）所有行中的最大视觉列数。 */
export function maxColsOf(rows: AlignedRow[], side: "left" | "right" | "both"): number {
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const { left, right } = rows[i];
    if (side !== "right" && left) max = Math.max(max, visualCols(left.content));
    if (side !== "left" && right) max = Math.max(max, visualCols(right.content));
  }
  return max;
}

/** 计算虚拟滚动可视窗口起止行下标（含 overscan 缓冲）。 */
export function computeVisibleWindow(
  lineCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): { start: number; end: number } {
  if (lineCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(lineCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end };
}

/** 计算上/下一处变更跳转的目标行下标。 */
export function findNextChangeIndex(
  changeIndices: number[],
  firstVisible: number,
  direction: 1 | -1,
): number | undefined {
  let cur = -1;
  for (let k = 0; k < changeIndices.length; k++) {
    if (changeIndices[k] <= firstVisible) cur = k;
    else break;
  }
  if (direction > 0) return changeIndices[cur + 1];
  if (cur >= 0) {
    return firstVisible > changeIndices[cur] ? changeIndices[cur] : changeIndices[cur - 1];
  }
  return undefined;
}

/** 把分栏 AlignedRow[] 展平为统一视图行序列（修改对拆为先删后增两行，跳过双空行）。 */
export function buildUnifiedLines(rows: AlignedRow[]): {
  lines: UnifiedLine[];
  changeLineIndices: number[];
} {
  return buildUnifiedLinesFromItems(
    rows,
    rows.map((_, i) => ({ kind: "row", rowIndex: i }) as const),
  );
}

/** 与 buildUnifiedLines 相同，但按显示项（含折叠占位）输出。 */
export function buildUnifiedLinesFromItems(
  rows: AlignedRow[],
  items: ReadonlyArray<
    | { kind: "row"; rowIndex: number }
    | {
        kind: "fold";
        foldIndex: number;
        hiddenCount: number;
        fromLineNo: number | null;
        toLineNo: number | null;
      }
  >,
): {
  lines: UnifiedLine[];
  changeLineIndices: number[];
} {
  const lines: UnifiedLine[] = [];
  const changeLineIndices: number[] = [];
  const pushChangeIdx = () => {
    const l = lines.length - 1;
    if (l >= 0 && lines[l].cell.kind !== "context") changeLineIndices.push(l);
  };
  for (const item of items) {
    if (item.kind === "fold") {
      lines.push({
        oldNo: null,
        newNo: null,
        cell: { kind: "context", lineno: null, content: "", charRanges: [] },
        rowIndex: -1,
        side: "old",
        fold: {
          foldIndex: item.foldIndex,
          hiddenCount: item.hiddenCount,
          fromLineNo: item.fromLineNo,
          toLineNo: item.toLineNo,
        },
      });
      continue;
    }
    const i = item.rowIndex;
    const { left, right } = rows[i];
    if (left && right) {
      if (left.kind === "context") {
        lines.push({
          oldNo: left.lineno,
          newNo: right.lineno,
          cell: left,
          rowIndex: i,
          side: "old",
        });
        pushChangeIdx();
      } else {
        lines.push({ oldNo: left.lineno, newNo: null, cell: left, rowIndex: i, side: "old" });
        pushChangeIdx();
        lines.push({ oldNo: null, newNo: right.lineno, cell: right, rowIndex: i, side: "new" });
        pushChangeIdx();
      }
    } else if (left) {
      lines.push({ oldNo: left.lineno, newNo: null, cell: left, rowIndex: i, side: "old" });
      pushChangeIdx();
    } else if (right) {
      lines.push({ oldNo: null, newNo: right.lineno, cell: right, rowIndex: i, side: "new" });
      pushChangeIdx();
    }
  }
  return { lines, changeLineIndices };
}

/** 分栏/统一视图中变更行侧键（用于选区追踪）。 */
export function lineSelectionKey(rowIndex: number, side: "old" | "new"): string {
  return `${rowIndex}:${side}`;
}

/** 从分栏视图的一个连续变更块（[start, start + count)）构造整块应用选区。 */
export function buildSplitHunkSelections(
  rows: AlignedRow[],
  start: number,
  count: number,
): DiffLineSelection[] {
  const indices: number[] = [];
  const end = Math.min(rows.length, start + count);
  for (let i = Math.max(0, start); i < end; i++) indices.push(i);
  return buildHunkSelectionsForRowIndices(rows, indices);
}

/** 按任意行下标集合构造整块应用选区（折叠布局下由显示块映射回真实行）。 */
export function buildHunkSelectionsForRowIndices(
  rows: AlignedRow[],
  rowIndices: number[],
): DiffLineSelection[] {
  const out: DiffLineSelection[] = [];
  for (const i of rowIndices) {
    const row = rows[i];
    if (!row) continue;
    const hasLeft = row.left?.kind === "removed";
    const hasRight = row.right?.kind === "added";
    if (hasLeft && hasRight) {
      out.push({ rowIndex: i, side: "both" });
    } else if (hasLeft) {
      out.push({ rowIndex: i, side: "old" });
    } else if (hasRight) {
      out.push({ rowIndex: i, side: "new" });
    }
  }
  return out;
}

/** 从统一视图的一个连续变更块（[start, start + count)）构造整块应用选区。 */
export function buildUnifiedHunkSelections(
  lines: UnifiedLine[],
  start: number,
  count: number,
): DiffLineSelection[] {
  const keys = new Set<string>();
  const end = Math.min(lines.length, start + count);
  for (let i = Math.max(0, start); i < end; i++) {
    const line = lines[i];
    if (line.cell.kind !== "context") {
      keys.add(lineSelectionKey(line.rowIndex, line.side));
    }
  }
  return keysToSelections(keys);
}

/** 把选区集合（`rowIndex:side`）归并排序为后端可用的 `DiffLineSelection[]`。 */
export function keysToSelections(keys: ReadonlySet<string>): DiffLineSelection[] {
  const byRow = new Map<number, { old: boolean; new: boolean }>();
  for (const key of keys) {
    const sep = key.lastIndexOf(":");
    if (sep <= 0) continue;
    const rowIndex = Number(key.slice(0, sep));
    const side = key.slice(sep + 1);
    if (!Number.isInteger(rowIndex) || rowIndex < 0) continue;
    const rec = byRow.get(rowIndex) ?? { old: false, new: false };
    if (side === "old") rec.old = true;
    else if (side === "new") rec.new = true;
    byRow.set(rowIndex, rec);
  }
  const indices = [...byRow.keys()].sort((a, b) => a - b);
  return indices.map((rowIndex) => {
    const rec = byRow.get(rowIndex)!;
    const side: PatchSide = rec.old && rec.new ? "both" : rec.old ? "old" : "new";
    return { rowIndex, side };
  });
}

/** 计算给定行的有效可选侧键（分栏单行可选 old/new 或两侧）。 */
export function splitRowSelectionKeys(row: AlignedRow, rowIndex: number): string[] {
  const out: string[] = [];
  if (row.left?.kind === "removed") out.push(lineSelectionKey(rowIndex, "old"));
  if (row.right?.kind === "added") out.push(lineSelectionKey(rowIndex, "new"));
  return out;
}
