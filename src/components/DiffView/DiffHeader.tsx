/**
 * Diff 视图顶栏 — docs/06 §4.1。
 *
 * 左侧：文件切换胶囊（上一文件 / "i/N" 下拉 / 下一文件）/ 文件路径 / +/- 统计。
 * 右侧：变更计数 / 上下变更导航 / 分栏-统一模式切换 / 关闭按钮。
 */

import type { ChangedFile, DiffScope, FileDiffResult } from "../../types";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CloseIcon,
  HistoryIcon,
  LinkIcon,
  SplitViewIcon,
  UnifiedViewIcon,
  UnlinkIcon,
} from "../Icons";
import DiffFileList from "./DiffFileList";
import { GOTO_CHANGE_EVENT, type GotoChangeDetail } from "./SplitDiffGrid";

/** 视图模式。 */
export type DiffMode = "split" | "unified";

export interface DiffHeaderProps {
  files: ChangedFile[];
  currentIndex: number;
  diff: FileDiffResult;
  scope: DiffScope | null;
  scopeLabel?: string | null;
  loading: boolean;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  /** 分栏模式下左右是否同步横向滚动。 */
  hLinked: boolean;
  onToggleHLinked: () => void;
  onPrevFile: () => void;
  onNextFile: () => void;
  onSelectFile: (index: number) => void;
  onOpenBlame?: () => void;
  onClose: () => void;
}

const IS_MAC = navigator.userAgent.includes("Mac");
const MODE_SHORTCUT = IS_MAC ? "⌘D" : "Ctrl+D";
const ALT_KEY = IS_MAC ? "⌥" : "Alt";

/** 派发跳转变更事件（SplitDiffGrid / UnifiedGrid 监听并滚动）。 */
function gotoChange(direction: GotoChangeDetail["direction"]) {
  window.dispatchEvent(
    new CustomEvent<GotoChangeDetail>(GOTO_CHANGE_EVENT, { detail: { direction } }),
  );
}

function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

function scopePillText(scope: DiffScope | null, scopeLabel?: string | null): string | null {
  if (!scope) return null;
  switch (scope.kind) {
    case "workdir":
      return "工作区";
    case "staged":
      return "已暂存";
    case "commit":
      return scope.commitId.slice(0, 7);
    case "range":
      return scopeLabel || `${scope.baseRef.slice(0, 7)} → ${scope.targetRef.slice(0, 7)}`;
  }
}

export default function DiffHeader({
  files,
  currentIndex,
  diff,
  scope,
  scopeLabel,
  loading,
  mode,
  onModeChange,
  hLinked,
  onToggleHLinked,
  onPrevFile,
  onNextFile,
  onSelectFile,
  onOpenBlame,
  onClose,
}: DiffHeaderProps) {
  const { oldPath, newPath } = diff;
  const isRenamed = Boolean(oldPath && newPath && oldPath !== newPath);
  const displayPath = isRenamed ? `${oldPath} → ${newPath}` : (newPath ?? oldPath ?? "");
  const { dir, base } = splitPath(newPath ?? oldPath ?? "");
  const changeCount = diff.changeRowIndices.length;
  const pill = scopePillText(scope, scopeLabel);

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

        {pill && (
          <span
            className={`diff-header__scope-pill${scope?.kind === "staged" ? " is-staged" : scope?.kind === "range" ? " is-range" : ""}`}
            title={pill}
          >
            {pill}
          </span>
        )}

        <span
          className="diff-header__stats"
          aria-label={`新增 ${diff.additions} 行，删除 ${diff.deletions} 行`}
        >
          <span className="diff-header__stat-pill diff-header__stat-pill--add">
            +{diff.additions}
          </span>
          <span className="diff-header__stat-pill diff-header__stat-pill--remove">
            −{diff.deletions}
          </span>
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

        {mode === "split" && (
          <button
            type="button"
            className={`diff-header__btn diff-header__link${hLinked ? " is-active" : ""}`}
            aria-pressed={hLinked}
            aria-label={hLinked ? "左右同步横向滚动" : "左右独立横向滚动"}
            title={
              hLinked
                ? `左右同步横向滚动（点击切换为各自独立；按住 ${ALT_KEY} 滚动可临时只滚动一侧）`
                : "左右各自独立横向滚动（点击切换为同步）"
            }
            onClick={onToggleHLinked}
          >
            {hLinked ? <LinkIcon /> : <UnlinkIcon />}
          </button>
        )}

        <div
          className="diff-header__mode"
          role="group"
          aria-label="视图模式"
          title={`切换视图模式 (${MODE_SHORTCUT})`}
        >
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

        {onOpenBlame && (
          <button
            type="button"
            className="diff-header__btn diff-header__blame"
            aria-label="查看逐行 Blame"
            title="查看逐行 Blame"
            onClick={onOpenBlame}
          >
            <HistoryIcon />
            <span>Blame</span>
          </button>
        )}

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
