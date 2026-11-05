/**
 * Diff 视图顶栏 — docs/06 §4.1。
 *
 * 左侧：上一文件 / "i/N" 文件下拉 / 下一文件 / 文件路径 / +/- 统计。
 * 右侧：变更计数 / 上下变更导航（派发 window 事件）/ 分栏-统一切换 /
 * 关闭按钮。
 */

import type { ChangedFile, FileDiffResult } from "../../types";
import DiffFileList from "./DiffFileList";
import { GOTO_CHANGE_EVENT, type GotoChangeDetail } from "./SplitDiffGrid";

/** 视图模式。 */
export type DiffMode = "split" | "unified";

export interface DiffHeaderProps {
  files: ChangedFile[];
  currentIndex: number;
  diff: FileDiffResult;
  loading: boolean;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  onPrevFile: () => void;
  onNextFile: () => void;
  onSelectFile: (index: number) => void;
  onClose: () => void;
}

/** 派发跳转变更事件（SplitDiffGrid / UnifiedGrid 监听并滚动）。 */
function gotoChange(direction: GotoChangeDetail["direction"]) {
  window.dispatchEvent(new CustomEvent<GotoChangeDetail>(GOTO_CHANGE_EVENT, { detail: { direction } }));
}

export default function DiffHeader({
  files,
  currentIndex,
  diff,
  loading,
  mode,
  onModeChange,
  onPrevFile,
  onNextFile,
  onSelectFile,
  onClose,
}: DiffHeaderProps) {
  const { oldPath, newPath } = diff;
  const displayPath =
    oldPath && newPath && oldPath !== newPath ? `${oldPath} → ${newPath}` : newPath ?? oldPath ?? "";
  const changeCount = diff.changeRowIndices.length;

  return (
    <header className="diff-header">
      <div className="diff-header__left">
        <button
          type="button"
          className="diff-header__btn"
          aria-label="上一个文件"
          title="上一个文件"
          disabled={currentIndex <= 0}
          onClick={onPrevFile}
        >
          ←
        </button>
        <DiffFileList files={files} currentIndex={currentIndex} onSelect={onSelectFile} />
        <button
          type="button"
          className="diff-header__btn"
          aria-label="下一个文件"
          title="下一个文件"
          disabled={currentIndex >= files.length - 1}
          onClick={onNextFile}
        >
          →
        </button>
        <span className="diff-header__path" title={displayPath}>
          {displayPath}
        </span>
        <span
          className="diff-header__stats"
          aria-label={`新增 ${diff.additions} 行，删除 ${diff.deletions} 行`}
        >
          <span className="diff-header__stat-add">+{diff.additions}</span>
          <span className="diff-header__stat-remove">−{diff.deletions}</span>
        </span>
      </div>
      <div className="diff-header__right">
        {loading && <span className="diff-header__loading">加载中…</span>}
        <span className="diff-header__changes">{changeCount} 处变更</span>
        <button
          type="button"
          className="diff-header__btn"
          aria-label="上一处变更"
          title="上一处变更"
          disabled={changeCount === 0}
          onClick={() => gotoChange(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="diff-header__btn"
          aria-label="下一处变更"
          title="下一处变更"
          disabled={changeCount === 0}
          onClick={() => gotoChange(1)}
        >
          ↓
        </button>
        <div className="diff-header__mode" role="group" aria-label="视图模式">
          <button
            type="button"
            className={mode === "split" ? "is-active" : ""}
            aria-pressed={mode === "split"}
            onClick={() => onModeChange("split")}
          >
            分栏
          </button>
          <button
            type="button"
            className={mode === "unified" ? "is-active" : ""}
            aria-pressed={mode === "unified"}
            onClick={() => onModeChange("unified")}
          >
            统一
          </button>
        </div>
        <button
          type="button"
          className="diff-header__btn"
          aria-label="关闭差异视图"
          title="关闭差异视图"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </header>
  );
}
