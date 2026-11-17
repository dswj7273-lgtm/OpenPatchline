import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { groupChangeBlocks } from "../components/DiffView/ChangeRail";
import SplitDiffGrid, { UnifiedGrid } from "../components/DiffView/SplitDiffGrid";
import {
  buildSplitHunkSelections,
  buildUnifiedHunkSelections,
  buildUnifiedLines,
  computeVisibleWindow,
  findNextChangeIndex,
  keysToSelections,
  lineSelectionKey,
  maxColsOf,
  visualCols,
} from "../components/DiffView/diffGridUtils";
import type { AlignedRow } from "../types";

const sampleRows: AlignedRow[] = [
  {
    left: { lineno: 1, content: "const a = 1;", kind: "context", charRanges: [] },
    right: { lineno: 1, content: "const a = 1;", kind: "context", charRanges: [] },
  },
  {
    left: {
      lineno: 2,
      content: "const b = oldVal;",
      kind: "removed",
      charRanges: [{ start: 10, end: 16 }],
    },
    right: {
      lineno: 2,
      content: "const b = newVal;",
      kind: "added",
      charRanges: [{ start: 10, end: 16 }],
    },
  },
  {
    left: null,
    right: { lineno: 3, content: "\t// 中文注释", kind: "added", charRanges: [] },
  },
];

describe("diffGridUtils", () => {
  it("computes visual columns for tabs, ASCII, and CJK characters", () => {
    expect(visualCols("abc")).toBe(3);
    expect(visualCols("\tabc")).toBe(7);
    expect(visualCols("中文a")).toBe(5);
    expect(maxColsOf(sampleRows, "left")).toBe(17);
    expect(maxColsOf(sampleRows, "right")).toBe(17);
    expect(maxColsOf(sampleRows, "both")).toBe(17);
  });

  it("computes virtual scroll window with overscan clamping", () => {
    expect(computeVisibleWindow(0, 0, 400, 20, 30)).toEqual({ start: 0, end: 0 });
    expect(computeVisibleWindow(200, 1000, 200, 20, 10)).toEqual({ start: 40, end: 70 });
    expect(computeVisibleWindow(50, 0, 200, 20, 30)).toEqual({ start: 0, end: 40 });
  });

  it("navigates forward and backward across change indices", () => {
    const indices = [3, 4, 10, 20];
    expect(findNextChangeIndex(indices, 0, 1)).toBe(3);
    expect(findNextChangeIndex(indices, 4, 1)).toBe(10);
    expect(findNextChangeIndex(indices, 20, 1)).toBeUndefined();
    expect(findNextChangeIndex(indices, 12, -1)).toBe(10);
    expect(findNextChangeIndex(indices, 10, -1)).toBe(4);
    expect(findNextChangeIndex(indices, 2, -1)).toBeUndefined();
  });

  it("flattens aligned rows into unified lines and groups change blocks", () => {
    const { lines, changeLineIndices } = buildUnifiedLines(sampleRows);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ oldNo: 1, newNo: 1, side: "old" });
    expect(lines[1]).toMatchObject({ oldNo: 2, newNo: null, side: "old" });
    expect(lines[2]).toMatchObject({ oldNo: null, newNo: 2, side: "new" });
    expect(lines[3]).toMatchObject({ oldNo: null, newNo: 3, side: "new" });
    expect(changeLineIndices).toEqual([1, 2, 3]);

    const blocks = groupChangeBlocks([1, 2, 3, 8], (idx) => (idx === 1 ? "remove" : "add"));
    expect(blocks).toEqual([
      { start: 1, count: 3, kind: "modify" },
      { start: 8, count: 1, kind: "add" },
    ]);
  });

  it("builds split/unified hunk selections and merges side keys cleanly", () => {
    expect(buildSplitHunkSelections(sampleRows, 1, 2)).toEqual([
      { rowIndex: 1, side: "both" },
      { rowIndex: 2, side: "new" },
    ]);
    const { lines } = buildUnifiedLines(sampleRows);
    expect(buildUnifiedHunkSelections(lines, 1, 3)).toEqual([
      { rowIndex: 1, side: "both" },
      { rowIndex: 2, side: "new" },
    ]);

    const keys = new Set([
      lineSelectionKey(2, "new"),
      lineSelectionKey(1, "old"),
      lineSelectionKey(1, "new"),
    ]);
    expect(keysToSelections(keys)).toEqual([
      { rowIndex: 1, side: "both" },
      { rowIndex: 2, side: "new" },
    ]);
  });
});

describe("SplitDiffGrid & UnifiedGrid", () => {
  it("renders split rows, spacer cells, and inline char highlights", () => {
    const { container } = render(
      <SplitDiffGrid
        rows={sampleRows}
        leftTokens={[[], [], []]}
        rightTokens={[[], [], []]}
        changeRowIndices={[1, 2]}
        hLinked
      />,
    );
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "3");
    const rowEls = screen.getAllByRole("row");
    expect(rowEls).toHaveLength(3);
    expect(container.querySelectorAll(".diff-cell--spacer")).toHaveLength(1);
    expect(container.querySelector(".char-remove")?.textContent).toBe("oldVal");
    expect(container.querySelector(".char-add")?.textContent).toBe("newVal");
  });

  it("renders unified rows with flattened old/new lines", () => {
    render(<UnifiedGrid rows={sampleRows} leftTokens={[[], [], []]} rightTokens={[[], [], []]} />);
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "4");
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("renders hunk buttons and line selection gutter in editable workdir/staged modes", () => {
    const onApplyHunk = vi.fn();
    const onToggleSelectLine = vi.fn();
    render(
      <SplitDiffGrid
        rows={sampleRows}
        leftTokens={[[], [], []]}
        rightTokens={[[], [], []]}
        changeRowIndices={[1, 2]}
        hLinked
        patchScope="workdir"
        onApplyHunk={onApplyHunk}
        onToggleSelectLine={onToggleSelectLine}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "+ 暂存块" }));
    expect(onApplyHunk).toHaveBeenCalledWith("stage", [
      { rowIndex: 1, side: "both" },
      { rowIndex: 2, side: "new" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "丢弃块" }));
    expect(onApplyHunk).toHaveBeenCalledWith("discard", [
      { rowIndex: 1, side: "both" },
      { rowIndex: 2, side: "new" },
    ]);

    const lineButtons = screen.getAllByRole("button", { name: /用于局部操作/ });
    expect(lineButtons.length).toBeGreaterThan(0);
    fireEvent.click(lineButtons[0], { shiftKey: true });
    expect(onToggleSelectLine).toHaveBeenCalledWith(1, "old", true);
  });
});
