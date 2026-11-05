/**
 * Split Diff 视图 — docs/06 §4。
 *
 * 数据源：useAppStore 的 currentFileDiff / diffFiles /
 * selectedDiffFileIndex / diffLoading。无选中文件时显示占位提示；
 * 有 diff 时 = DiffHeader + （分栏 | 统一）虚拟滚动网格。
 */

import { useMemo, useState } from "react";
import { extensionOf } from "../../highlighter/languages";
import { tokenize, type TokenSpan } from "../../highlighter/tokenizer";
import { useAppStore } from "../../store/app";
import type { AlignedRow } from "../../types";
import "./DiffView.css";
import "../../highlighter/tokens.css";
import DiffHeader, { type DiffMode } from "./DiffHeader";
import SplitDiffGrid, { UnifiedGrid } from "./SplitDiffGrid";

/** 单文件两侧的逐行 token（下标与 AlignedRow 一致）。 */
interface SideTokens {
  left: TokenSpan[][];
  right: TokenSpan[][];
}

const EMPTY_SIDE_TOKENS: SideTokens = { left: [], right: [] };

/** 把一侧全部行拼成完整文本（spacer 记为空行，行号 == 行下标）。 */
function sideContent(rows: AlignedRow[], side: "left" | "right"): string {
  return rows.map((r) => (side === "left" ? r.left : r.right)?.content ?? "").join("\n");
}

export function DiffView() {
  const currentFileDiff = useAppStore((s) => s.currentFileDiff);
  const diffFiles = useAppStore((s) => s.diffFiles);
  const selectedIndex = useAppStore((s) => s.selectedDiffFileIndex);
  const diffLoading = useAppStore((s) => s.diffLoading);
  const prevDiffFile = useAppStore((s) => s.prevDiffFile);
  const nextDiffFile = useAppStore((s) => s.nextDiffFile);
  const showDiffFile = useAppStore((s) => s.showDiffFile);
  const goBackToLog = useAppStore((s) => s.goBackToLog);

  // 视图模式为组件局部状态（不进全局 store）。
  const [mode, setMode] = useState<DiffMode>("split");

  // 语法分词。注意：所有 Hook 必须在早退 return 之前调用。
  const tokens = useMemo<SideTokens>(() => {
    if (!currentFileDiff) return EMPTY_SIDE_TOKENS;
    const { rows, newPath, oldPath } = currentFileDiff;
    const langId = extensionOf(newPath ?? oldPath ?? "");
    return {
      left: tokenize(sideContent(rows, "left"), langId),
      right: tokenize(sideContent(rows, "right"), langId),
    };
  }, [currentFileDiff]);

  if (!currentFileDiff) {
    return (
      <section className="diff-view diff-view--empty" aria-label="Diff 视图">
        <p className="diff-view__placeholder">
          {diffLoading ? "加载中…" : "选择一个文件查看差异"}
        </p>
      </section>
    );
  }

  const { rows, changeRowIndices, isBinary, tooLarge } = currentFileDiff;

  return (
    <section className="diff-view" aria-label="Diff 视图">
      <DiffHeader
        files={diffFiles}
        currentIndex={selectedIndex}
        diff={currentFileDiff}
        loading={diffLoading}
        mode={mode}
        onModeChange={setMode}
        onPrevFile={prevDiffFile}
        onNextFile={nextDiffFile}
        onSelectFile={showDiffFile}
        onClose={goBackToLog}
      />
      {tooLarge && (
        <div className="diff-view__banner" role="status">
          ⚠ 文件过大，仅显示部分内容
        </div>
      )}
      <div className="diff-view__body">
        {isBinary ? (
          <p className="diff-view__placeholder">二进制文件，无法显示文本差异</p>
        ) : rows.length === 0 ? (
          <p className="diff-view__placeholder">无差异</p>
        ) : mode === "split" ? (
          <SplitDiffGrid
            rows={rows}
            leftTokens={tokens.left}
            rightTokens={tokens.right}
            changeRowIndices={changeRowIndices}
          />
        ) : (
          <UnifiedGrid rows={rows} leftTokens={tokens.left} rightTokens={tokens.right} />
        )}
      </div>
    </section>
  );
}

// 同时提供默认导出，兼容两种导入约定。
export default DiffView;
