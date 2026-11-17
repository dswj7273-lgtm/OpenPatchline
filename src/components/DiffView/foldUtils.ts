/**
 * Diff 上下文折叠（v0.6 / 6.5）：把连续过长的未变更区折叠为占位行。
 *
 * 纯计算模块：由 AlignedRow[] 计算折叠区间，再按展开状态构建
 * "显示项"序列（行 / 折叠占位），供分栏与统一网格共用；
 * rowIndex → displayIndex 的映射用于变更导航与选区定位换算。
 */

import type { AlignedRow } from "../../types";

/** 连续未变更行超过该阈值才产生折叠区间。 */
export const FOLD_THRESHOLD = 6;
/** 折叠时区间两端各保留的上下文行数。 */
export const FOLD_CONTEXT = 3;

/** 折叠区间：隐藏的行下标范围 [start, end)。 */
export interface FoldRange {
  start: number;
  end: number;
}

/** 显示项：真实行或折叠占位。 */
export type DisplayItem =
  | { kind: "row"; rowIndex: number }
  | {
      kind: "fold";
      foldIndex: number;
      hiddenCount: number;
      fromLineNo: number | null;
      toLineNo: number | null;
    };

/** 折叠布局：显示项序列 + 行下标到显示下标的映射（隐藏行为 -1）。 */
export interface FoldLayout {
  items: DisplayItem[];
  rowDisplayIndex: number[];
}

/** 该行是否为两侧都未变更的上下文行（spacer 行视为变更行，不折叠）。 */
export function isContextRow(row: AlignedRow): boolean {
  return row.left?.kind === "context" && row.right?.kind === "context";
}

/** 计算全部可折叠区间（连续上下文行数 > FOLD_THRESHOLD 时，两端各保留 FOLD_CONTEXT 行）。 */
export function computeFoldRanges(rows: AlignedRow[]): FoldRange[] {
  const folds: FoldRange[] = [];
  const minRun = FOLD_THRESHOLD + 2 * FOLD_CONTEXT;
  let runStart = -1;
  for (let i = 0; i <= rows.length; i++) {
    const isCtx = i < rows.length && isContextRow(rows[i]);
    if (isCtx) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const runLen = i - runStart;
      if (runLen > minRun) {
        folds.push({ start: runStart + FOLD_CONTEXT, end: i - FOLD_CONTEXT });
      }
      runStart = -1;
    }
  }
  return folds;
}

/** 构建显示项序列；expandedFolds 为已展开的折叠区间下标集合。 */
export function buildFoldLayout(
  rows: AlignedRow[],
  folds: FoldRange[],
  expandedFolds: ReadonlySet<number>,
): FoldLayout {
  const items: DisplayItem[] = [];
  const rowDisplayIndex = new Array<number>(rows.length).fill(-1);
  let foldCursor = 0; // 下一个尚未消费的折叠区间
  for (let i = 0; i < rows.length; i++) {
    // 进入折叠区间且未展开：输出占位并跳过隐藏行。
    const fold = folds[foldCursor];
    if (fold && i === fold.start) {
      if (!expandedFolds.has(foldCursor)) {
        const hiddenCount = fold.end - fold.start;
        const first = rows[fold.start];
        const last = rows[fold.end - 1];
        items.push({
          kind: "fold",
          foldIndex: foldCursor,
          hiddenCount,
          fromLineNo: first?.right?.lineno ?? first?.left?.lineno ?? null,
          toLineNo: last?.right?.lineno ?? last?.left?.lineno ?? null,
        });
        foldCursor += 1;
        i = fold.end - 1; // for 循环再 +1 → 跳到 fold.end
        continue;
      }
      foldCursor += 1;
      // 展开的折叠区间按普通行继续输出（下方统一记录 rowDisplayIndex）
    }
    rowDisplayIndex[i] = items.length;
    items.push({ kind: "row", rowIndex: i });
  }
  return { items, rowDisplayIndex };
}

/** 折叠占位行的展示文案。 */
export function foldLabel(item: {
  hiddenCount: number;
  fromLineNo: number | null;
  toLineNo: number | null;
}): string {
  const range =
    item.fromLineNo !== null && item.toLineNo !== null && item.toLineNo > item.fromLineNo
      ? `（第 ${item.fromLineNo}–${item.toLineNo} 行）`
      : "";
  return `⋯ 已折叠 ${item.hiddenCount} 行未更改内容 ${range}，点击展开 ⋯`;
}
