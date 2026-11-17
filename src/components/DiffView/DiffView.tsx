/**
 * Split Diff 视图 — docs/06 §4。
 *
 * 数据源：useAppStore 的 currentFileDiff / diffFiles /
 * selectedDiffFileIndex / diffLoading。无选中文件时显示占位提示；
 * 有 diff 时 = DiffHeader + （局部选区操作条）+ （分栏 | 统一）虚拟滚动网格。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extensionOf } from "../../highlighter/extensions";
import {
  EMPTY_SIDE_TOKENS,
  getCachedHighlight,
  requestHighlight,
  type SideTokens,
} from "../../highlighter/workerClient";
import { useAppStore } from "../../store/app";
import type { AlignedRow, DiffLineSelection, DiffPatchAction } from "../../types";
import { AlertIcon } from "../Icons";
import "./DiffView.css";
import "../../highlighter/tokens.css";
import { keysToSelections, lineSelectionKey } from "./diffGridUtils";
import DiffHeader, { type DiffMode } from "./DiffHeader";
import SplitDiffGrid, {
  GOTO_CHANGE_EVENT,
  UnifiedGrid,
  type GotoChangeDetail,
} from "./SplitDiffGrid";

/** 把一侧全部行拼成完整文本（spacer 记为空行，行号 == 行下标）。 */
function sideContent(rows: AlignedRow[], side: "left" | "right"): string {
  return rows.map((r) => (side === "left" ? r.left : r.right)?.content ?? "").join("\n");
}

const H_LINKED_KEY = "openpatchline:diff-hscroll-linked";

/** 读取左右横向滚动同步偏好（默认同步）。 */
function readHLinked(): boolean {
  try {
    return window.localStorage.getItem(H_LINKED_KEY) !== "false";
  } catch {
    return true;
  }
}

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

export function DiffView() {
  const currentFileDiff = useAppStore((s) => s.currentFileDiff);
  const diffFiles = useAppStore((s) => s.diffFiles);
  const selectedIndex = useAppStore((s) => s.selectedDiffFileIndex);
  const diffLoading = useAppStore((s) => s.diffLoading);
  const diffScope = useAppStore((s) => s.diffScope);
  const compareRange = useAppStore((s) => s.compareRange);
  const fileStatus = useAppStore((s) => s.fileStatus);
  const gitBusy = useAppStore((s) => s.gitBusy);
  const prevDiffFile = useAppStore((s) => s.prevDiffFile);
  const nextDiffFile = useAppStore((s) => s.nextDiffFile);
  const showDiffFile = useAppStore((s) => s.showDiffFile);
  const goBackToLog = useAppStore((s) => s.goBackToLog);
  const applyDiffSelection = useAppStore((s) => s.applyDiffSelection);
  const openConflictFile = useAppStore((s) => s.openConflictFile);
  const openFileBlame = useAppStore((s) => s.openFileBlame);

  const [mode, setMode] = useState<DiffMode>("split");
  const [hLinked, setHLinked] = useState(readHLinked);

  const [explicitState, setExplicitState] = useState<{
    diff: object | null;
    keys: Set<string>;
  }>({ diff: null, keys: new Set() });
  const [dragState, setDragState] = useState<{
    diff: object | null;
    keys: Set<string>;
  }>({ diff: null, keys: new Set() });
  const anchorRef = useRef<{
    diff: object | null;
    rowIndex: number;
    side: "old" | "new";
  } | null>(null);

  const toggleHLinked = () => {
    setHLinked((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(H_LINKED_KEY, String(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  };

  // 快捷键：Cmd/Ctrl+D 切换分栏/统一，[ / ] 跳转上一处/下一处变更。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (inInput) return;

      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setMode((m) => (m === "split" ? "unified" : "split"));
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        const direction: GotoChangeDetail["direction"] = e.key === "[" ? -1 : 1;
        window.dispatchEvent(
          new CustomEvent<GotoChangeDetail>(GOTO_CHANGE_EVENT, { detail: { direction } }),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const diffSides = useMemo(() => {
    if (
      !currentFileDiff ||
      currentFileDiff.isBinary ||
      currentFileDiff.tooLarge ||
      currentFileDiff.rows.length === 0
    ) {
      return null;
    }
    const { rows, newPath, oldPath } = currentFileDiff;
    return {
      left: sideContent(rows, "left"),
      right: sideContent(rows, "right"),
      langId: extensionOf(newPath ?? oldPath ?? ""),
    };
  }, [currentFileDiff]);

  const [asyncTokens, setAsyncTokens] = useState<{ key: object | null; value: SideTokens }>({
    key: null,
    value: EMPTY_SIDE_TOKENS,
  });

  // 同步命中缓存时立即返回，切回已访问文件无闪烁；未命中时交给 Worker 异步分词并支持取消。
  const cachedTokens = useMemo(() => {
    if (!diffSides) return EMPTY_SIDE_TOKENS;
    return getCachedHighlight(diffSides.left, diffSides.right, diffSides.langId);
  }, [diffSides]);

  useEffect(() => {
    if (!currentFileDiff || !diffSides || cachedTokens !== null) return;
    const key = currentFileDiff;
    return requestHighlight(diffSides.left, diffSides.right, diffSides.langId, (res) => {
      setAsyncTokens({ key, value: res });
    });
  }, [currentFileDiff, diffSides, cachedTokens]);

  const tokens: SideTokens =
    cachedTokens ?? (asyncTokens.key === currentFileDiff ? asyncTokens.value : EMPTY_SIDE_TOKENS);

  const activePath = diffFiles[selectedIndex]?.path ?? null;
  const currentStatus = useMemo(
    () => (activePath ? fileStatus.find((f) => f.path === activePath) : undefined),
    [fileStatus, activePath],
  );
  const patchScope: "workdir" | "staged" | null =
    currentFileDiff &&
    !currentFileDiff.isBinary &&
    !currentFileDiff.tooLarge &&
    !currentStatus?.conflicted &&
    (diffScope?.kind === "workdir" || diffScope?.kind === "staged")
      ? diffScope.kind
      : null;

  const explicitKeys: ReadonlySet<string> =
    explicitState.diff === currentFileDiff ? explicitState.keys : EMPTY_KEY_SET;
  const dragKeys: ReadonlySet<string> =
    dragState.diff === currentFileDiff ? dragState.keys : EMPTY_KEY_SET;
  const highlightedKeys = explicitKeys.size > 0 ? explicitKeys : dragKeys;

  const activeSelections = useMemo(
    () => (patchScope ? keysToSelections(highlightedKeys) : []),
    [patchScope, highlightedKeys],
  );

  const clearSelection = useCallback(() => {
    setExplicitState({ diff: currentFileDiff, keys: new Set() });
    setDragState({ diff: currentFileDiff, keys: new Set() });
    anchorRef.current = null;
  }, [currentFileDiff]);

  const onToggleSelectLine = useCallback(
    (rowIndex: number, side: "old" | "new", shiftKey: boolean) => {
      if (!currentFileDiff) return;
      const anchor = anchorRef.current;
      setExplicitState((prev) => {
        const base = prev.diff === currentFileDiff ? new Set(prev.keys) : new Set<string>();
        if (shiftKey && anchor && anchor.diff === currentFileDiff) {
          const lo = Math.min(anchor.rowIndex, rowIndex);
          const hi = Math.max(anchor.rowIndex, rowIndex);
          const sameSide = anchor.side === side;
          for (let r = lo; r <= hi; r++) {
            const row = currentFileDiff.rows[r];
            if (!row) continue;
            if ((sameSide ? side === "old" : true) && row.left?.kind === "removed") {
              base.add(lineSelectionKey(r, "old"));
            }
            if ((sameSide ? side === "new" : true) && row.right?.kind === "added") {
              base.add(lineSelectionKey(r, "new"));
            }
          }
        } else {
          const key = lineSelectionKey(rowIndex, side);
          if (base.has(key)) base.delete(key);
          else base.add(key);
        }
        anchorRef.current = { diff: currentFileDiff, rowIndex, side };
        return { diff: currentFileDiff, keys: base };
      });
    },
    [currentFileDiff],
  );

  const onDragSelectLines = useCallback(
    (keys: Set<string>) => {
      if (!currentFileDiff) return;
      setDragState({ diff: currentFileDiff, keys });
    },
    [currentFileDiff],
  );

  const handleApplySelections = useCallback(
    async (action: DiffPatchAction, selections: DiffLineSelection[]) => {
      if (selections.length === 0) return;
      const ok = await applyDiffSelection(action, selections);
      if (ok) {
        setExplicitState({ diff: null, keys: new Set() });
        setDragState({ diff: null, keys: new Set() });
        anchorRef.current = null;
      }
    },
    [applyDiffSelection],
  );

  if (!currentFileDiff) {
    return (
      <section className="diff-view diff-view--empty" aria-label="Diff 视图">
        <p className="diff-view__placeholder">
          {diffLoading ? "加载差异中…" : "选择一个文件查看差异"}
        </p>
      </section>
    );
  }

  const { rows, changeRowIndices, isBinary, tooLarge } = currentFileDiff;
  const scopeLabel =
    diffScope?.kind === "range" && compareRange
      ? `${compareRange.baseLabel} → ${compareRange.targetLabel}`
      : null;
  const patchBusy = gitBusy !== null;
  const blameTargetPath = currentFileDiff.newPath ?? currentFileDiff.oldPath ?? activePath;
  const canBlame =
    !isBinary &&
    currentFileDiff.changeType !== "deleted" &&
    currentFileDiff.changeType !== "untracked" &&
    currentStatus?.unstaged !== "untracked" &&
    Boolean(blameTargetPath);
  const blameCommitId =
    diffScope?.kind === "commit"
      ? diffScope.commitId
      : diffScope?.kind === "range"
        ? diffScope.targetRef
        : null;

  return (
    <section className="diff-view" aria-label="Diff 视图">
      <DiffHeader
        files={diffFiles}
        currentIndex={selectedIndex}
        diff={currentFileDiff}
        scope={diffScope}
        scopeLabel={scopeLabel}
        loading={diffLoading}
        mode={mode}
        onModeChange={setMode}
        hLinked={hLinked}
        onToggleHLinked={toggleHLinked}
        onPrevFile={prevDiffFile}
        onNextFile={nextDiffFile}
        onSelectFile={showDiffFile}
        onOpenBlame={
          canBlame && blameTargetPath
            ? () => void openFileBlame(blameTargetPath, blameCommitId, { returnView: "diff" })
            : undefined
        }
        onClose={goBackToLog}
      />
      {currentStatus?.conflicted && activePath && (
        <div className="diff-view__banner diff-view__banner--conflict" role="status">
          <AlertIcon />
          <span>当前文件存在合并冲突，可在三方合并冲突编辑器中逐块对比解决</span>
          <button
            type="button"
            className="btn btn-primary diff-view__banner-cta"
            onClick={() => void openConflictFile(activePath)}
          >
            打开三方合并编辑器
          </button>
        </div>
      )}
      {tooLarge && (
        <div className="diff-view__banner" role="status">
          <AlertIcon />
          <span>文件过大，仅显示部分差异内容</span>
        </div>
      )}
      {!tooLarge && tokens.degraded && (
        <div className="diff-view__banner" role="status">
          <AlertIcon />
          <span>文件行数或单行长度超出阈值，已对语法高亮进行部分/纯文本降级以保持滚动流畅</span>
        </div>
      )}
      {patchScope && activeSelections.length > 0 && (
        <div className="diff-selection-bar" role="region" aria-label="行级选区操作">
          <span className="diff-selection-bar__count">
            已选中 {highlightedKeys.size} 行（{activeSelections.length} 处对齐）
          </span>
          <div className="diff-selection-bar__actions">
            {patchScope === "workdir" ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary diff-selection-bar__btn"
                  disabled={patchBusy}
                  onClick={() => void handleApplySelections("stage", activeSelections)}
                >
                  暂存所选行
                </button>
                <button
                  type="button"
                  className="btn diff-selection-bar__btn diff-selection-bar__btn--danger"
                  disabled={patchBusy}
                  onClick={() => void handleApplySelections("discard", activeSelections)}
                >
                  丢弃所选行
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn diff-selection-bar__btn"
                disabled={patchBusy}
                onClick={() => void handleApplySelections("unstage", activeSelections)}
              >
                取消暂存所选行
              </button>
            )}
            <button
              type="button"
              className="btn diff-selection-bar__btn"
              disabled={patchBusy}
              onClick={clearSelection}
            >
              取消选择
            </button>
          </div>
        </div>
      )}
      <div className="diff-view__body">
        {isBinary ? (
          <p className="diff-view__placeholder">二进制文件，无法显示文本差异</p>
        ) : rows.length === 0 ? (
          <p className="diff-view__placeholder">文件内容无文本差异</p>
        ) : mode === "split" ? (
          <SplitDiffGrid
            rows={rows}
            leftTokens={tokens.left}
            rightTokens={tokens.right}
            changeRowIndices={changeRowIndices}
            hLinked={hLinked}
            patchScope={patchScope}
            patchBusy={patchBusy}
            selectedKeys={explicitKeys}
            onToggleSelectLine={onToggleSelectLine}
            onDragSelectLines={onDragSelectLines}
            onApplyHunk={handleApplySelections}
          />
        ) : (
          <UnifiedGrid
            rows={rows}
            leftTokens={tokens.left}
            rightTokens={tokens.right}
            patchScope={patchScope}
            patchBusy={patchBusy}
            selectedKeys={explicitKeys}
            onToggleSelectLine={onToggleSelectLine}
            onDragSelectLines={onDragSelectLines}
            onApplyHunk={handleApplySelections}
          />
        )}
      </div>
    </section>
  );
}

export default DiffView;
