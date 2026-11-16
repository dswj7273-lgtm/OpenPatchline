/**
 * Diff 视图顶栏 — docs/06 §4.1。
 *
 * 左侧：文件切换胶囊（上一文件 / "i/N" 下拉 / 下一文件）/ 文件路径 / +/- 统计。
 * 右侧：变更计数 / 上下变更导航 / 分栏-统一模式切换 / 关闭按钮。
 */

import type { ChangedFile, FileDiffResult } from "../../types";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CloseIcon,
  SplitViewIcon,
  UnifiedViewIcon,
} from "../Icons";
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

const MODE_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘D" : "Ctrl+D";

/** 派发跳转变更事件（SplitDiffGrid / UnifiedGrid 监听并滚动）。 */
function gotoChange(direction: GotoChangeDetail["direction"]) {
  window.dispatchEvent(new CustomEvent<GotoChangeDetail>(GOTO_CHANGE_EVENT, { detail: { direction } }));
}

function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
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
  const isRenamed = Boolean(oldPath && newPath && oldPath !== newPath);
  const displayPath = isRenamed ? `${oldPath} → ${newPath}` : newPath ?? oldPath ?? "";
  const { dir, base } = splitPath(newPath ?? oldPath ?? "");
  const changeCount = diff.changeRowIndices.length;

  return (
    <header className="diff-header">
      <div className="diff-header__left">
        <div className="diff-header__nav">
          <button
            type="button"
            className="diff-header__btn"
            aria-label="上一个文件"
            title="上一个文件"
            disabled={currentIndex <= 0}
            onClick={onPrevFile}
          >
            <ArrowLeftIcon />
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
            <ArrowRightIcon />
          </button>
        </div>

        <span className="diff-header__path" title={displayPath}>
          {isRenamed ? (
            <span className="diff-header__path-base">{displayPath}</span>
          ) : (
            <>
              {dir && <span className="diff-header__path-dir">{dir}</span>}
              <span className="diff-header__path-base">{base}</span>
            </>
          )}
        </span>

        <span
          className="diff-header__stats"
          aria-label={`新增 ${diff.additions} 行，删除 ${diff.deletions} 行`}
        >
          <span className="diff-header__stat-pill diff-header__stat-pill--add">+{diff.additions}</span>
          <span className="diff-header__stat-pill diff-header__stat-pill--remove">−{diff.deletions}</span>
        </span>
      </div>

      <div className="diff-header__right">
        {loading && <span className="diff-header__loading">加载中…</span>}
        <div className="diff-header__hunks">
          <span className="diff-header__changes">{changeCount} 处变更</span>
          <button
            type="button"
            className="diff-header__btn"
            aria-label="上一处变更"
            title="上一处变更 ([)"
            disabled={changeCount === 0}
            onClick={() => gotoChange(-1)}
          >
            <ArrowUpIcon />
          </button>
          <button
            type="button"
            className="diff-header__btn"
            aria-label="下一处变更"
            title="下一处变更 (])"
            disabled={changeCount === 0}
            onClick={() => gotoChange(1)}
          >
            <ArrowDownIcon />
          </button>
        </div>

        <div className="diff-header__mode" role="group" aria-label="视图模式" title={`切换视图模式 (${MODE_SHORTCUT})`}>
          <button
            type="button"
            className={mode === "split" ? "is-active" : ""}
            aria-pressed={mode === "split"}
            onClick={() => onModeChange("split")}
          >
            <SplitViewIcon />
            <span>分栏</span>
          </button>
          <button
            type="button"
            className={mode === "unified" ? "is-active" : ""}
            aria-pressed={mode === "unified"}
            onClick={() => onModeChange("unified")}
          >
            <UnifiedViewIcon />
            <span>统一</span>
          </button>
        </div>

        <button
          type="button"
          className="diff-header__btn diff-header__close"
          aria-label="关闭差异视图"
          title="关闭差异视图 (Esc)"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}
