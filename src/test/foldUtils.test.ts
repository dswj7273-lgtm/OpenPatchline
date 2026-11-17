import { describe, expect, it } from "vitest";
import type { AlignedRow, RowCell } from "../types";
import {
  FOLD_CONTEXT,
  FOLD_THRESHOLD,
  buildFoldLayout,
  computeFoldRanges,
  foldLabel,
  isContextRow,
} from "../components/DiffView/foldUtils";

function ctx(n: number): RowCell {
  return { kind: "context", lineno: n, content: `line ${n}`, charRanges: [] };
}
function cell(kind: "added" | "removed", n: number): RowCell {
  return { kind, lineno: n, content: `${kind} ${n}`, charRanges: [] };
}

function row(left: RowCell | null, right: RowCell | null): AlignedRow {
  return { left, right };
}

/** 构造 [变更行, N 行上下文, 变更行, N 行上下文] 的行序列。 */
function makeRows(contextRun: number): AlignedRow[] {
  const rows: AlignedRow[] = [row(cell("added", 1), cell("added", 1))];
  for (let i = 0; i < contextRun; i++) rows.push(row(ctx(i + 10), ctx(i + 10)));
  rows.push(row(cell("removed", 99), cell("added", 99)));
  return rows;
}

describe("computeFoldRanges", () => {
  it("treats two-sided context rows as foldable, change rows not", () => {
    expect(isContextRow(row(ctx(1), ctx(1)))).toBe(true);
    expect(isContextRow(row(cell("added", 1), cell("added", 1)))).toBe(false);
    expect(isContextRow(row(null, cell("added", 1)))).toBe(false);
  });

  it("no fold for short context runs", () => {
    expect(computeFoldRanges(makeRows(FOLD_THRESHOLD))).toEqual([]);
  });

  it("folds long runs keeping 3 rows on each side", () => {
    const folds = computeFoldRanges(makeRows(FOLD_THRESHOLD + 2 * FOLD_CONTEXT + 1));
    expect(folds).toEqual([
      { start: 1 + FOLD_CONTEXT, end: 1 + FOLD_THRESHOLD + FOLD_CONTEXT + 1 },
    ]);
  });

  it("does not fold runs at file edges below threshold+2*context", () => {
    // 全上下文文件（无变更行）：整段是连续上下文，仍应折叠中段
    const all = Array.from({ length: 40 }, (_, i) => row(ctx(i + 1), ctx(i + 1)));
    const folds = computeFoldRanges(all);
    expect(folds).toEqual([{ start: FOLD_CONTEXT, end: 40 - FOLD_CONTEXT }]);
  });
});

describe("buildFoldLayout", () => {
  const rows = makeRows(20);
  const folds = computeFoldRanges(rows);
  // run = 1 变更 + 20 上下文 + 1 变更 → 折叠 [4, 18)
  expect(folds).toEqual([{ start: 4, end: 18 }]);

  it("collapsed layout replaces hidden rows with a fold marker", () => {
    const layout = buildFoldLayout(rows, folds, new Set());
    expect(layout.items.length).toBe(rows.length - 14 + 1);
    const foldItem = layout.items.find((i) => i.kind === "fold");
    expect(foldItem).toMatchObject({ kind: "fold", foldIndex: 0, hiddenCount: 14 });
    // 隐藏行的 rowDisplayIndex 为 -1，可见行单调递增
    expect(layout.rowDisplayIndex[4]).toBe(-1);
    expect(layout.rowDisplayIndex[17]).toBe(-1);
    expect(layout.rowDisplayIndex[3]).toBeLessThan(layout.rowDisplayIndex[18]);
    expect(foldLabel(foldItem!)).toContain("14");
  });

  it("expanded layout restores every row", () => {
    const layout = buildFoldLayout(rows, folds, new Set([0]));
    expect(layout.items.length).toBe(rows.length);
    expect(layout.items.every((i) => i.kind === "row")).toBe(true);
    expect(layout.rowDisplayIndex).toEqual(rows.map((_, i) => i));
  });
});
