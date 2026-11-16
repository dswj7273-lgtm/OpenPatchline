/**
 * Diff 网格纯计算辅助函数：统一视图行拆解、视觉列宽计算、可视窗口与变更导航定位。
 *
 * 与 DOM / React 解耦，供 SplitDiffGrid / UnifiedGrid 与单元测试共同复用。
 */

import type { AlignedRow, RowCell } from "../../types";

/** 统一视图的单行：旧 / 新行号 + 内容。 */
export interface UnifiedLine {
  oldNo: number | null;
  newNo: number | null;
  cell: RowCell;
  /** 源 AlignedRow 下标（token 查找用）。 */
  rowIndex: number;
  side: "old" | "new";
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
  const lines: UnifiedLine[] = [];
  const changeLineIndices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
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
      } else {
        lines.push({ oldNo: left.lineno, newNo: null, cell: left, rowIndex: i, side: "old" });
        lines.push({ oldNo: null, newNo: right.lineno, cell: right, rowIndex: i, side: "new" });
      }
    } else if (left) {
      lines.push({ oldNo: left.lineno, newNo: null, cell: left, rowIndex: i, side: "old" });
    } else if (right) {
      lines.push({ oldNo: null, newNo: right.lineno, cell: right, rowIndex: i, side: "new" });
    }
  }
  for (let l = 0; l < lines.length; l++) {
    if (lines[l].cell.kind !== "context") changeLineIndices.push(l);
  }
  return { lines, changeLineIndices };
}
