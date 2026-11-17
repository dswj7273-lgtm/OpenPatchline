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
import { matchesKeyId } from "../../keyboard/keymap";
import { buildFoldLayout, computeFoldRanges, type FoldLayout } from "./foldUtils";
import { useAppStore } from "../../store/app";
import type { AlignedRow, DiffLineSelection, DiffPatchAction } from "../../types";
import { useContextMenu } from "../ContextMenu/ContextMenu";
import { AlertIcon } from "../Icons";
import { copyText } from "../../utils/clipboard";
import { openFileContextMenu } from "../../utils/fileContextMenu";
import { reportError } from "../../utils/errors";
import * as api from "../../api/client";
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

  const [mode, setMode] = useState<DiffMode>(() => {
    const pref = useAppStore.getState().settings.defaultDiffMode;
    return pref === "unified" ? "unified" : "split";
  });
  const [hLinked, setHLinked] = useState(readHLinked);
  const [foldExpanded, setFoldExpanded] = useState<ReadonlySet<number>>(() => new Set());

  const diffIgnoreWhitespace = useAppStore((s) => s.diffIgnoreWhitespace);
  const settingsIgnoreWs = useAppStore((s) => s.settings.ignoreWhitespaceDefault);
  const setDiffIgnoreWhitespace = useAppStore((s) => s.setDiffIgnoreWhitespace);
  const ignoreWhitespace = diffIgnoreWhitespace ?? settingsIgnoreWs;

  /** 网格滚动容器与一次性恢复值（忽略空白切换时保持滚动位置）。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restoreScrollRef = useRef<number | null>(null);
  const fileMenu = useContextMenu();

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

  // 快捷键（docs/11 §三 6.3）：⌘D 切换分栏/统一；[ / ] 与 ⌥↑/⌥↓ 跳转
  // 上/下一处变更；⌘[ / ⌘] 切换上/下一个文件。均经 keymap 注册表匹配。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (inInput) return;

      if (matchesKeyId(e, "diff-mode")) {
        e.preventDefault();
        setMode((m) => (m === "split" ? "unified" : "split"));
        return;
      }
      if (matchesKeyId(e, "prev-file")) {
        e.preventDefault();
        void prevDiffFile();
        return;
      }
      if (matchesKeyId(e, "next-file")) {
        e.preventDefault();
        void nextDiffFile();
        return;
      }
      if (matchesKeyId(e, "prev-change-alt")) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent<GotoChangeDetail>(GOTO_CHANGE_EVENT, { detail: { direction: -1 } }),
        );
        return;
      }
      if (matchesKeyId(e, "next-change-alt")) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent<GotoChangeDetail>(GOTO_CHANGE_EVENT, { detail: { direction: 1 } }),
        );
        return;
      }
      if (matchesKeyId(e, "prev-change")) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent<GotoChangeDetail>(GOTO_CHANGE_EVENT, { detail: { direction: -1 } }),
        );
        return;
      }
      if (matchesKeyId(e, "next-change")) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent<GotoChangeDetail>(GOTO_CHANGE_EVENT, { detail: { direction: 1 } }),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prevDiffFile, nextDiffFile]);

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

  // 折叠布局（v0.6 / 6.5）：文件切换时折叠状态复位。
  const foldRows = currentFileDiff?.rows;
  const folds = useMemo(() => (foldRows ? computeFoldRanges(foldRows) : []), [foldRows]);
  const layout: FoldLayout | null = useMemo(
    () => (foldRows && folds.length > 0 ? buildFoldLayout(foldRows, folds, foldExpanded) : null),
    [foldRows, folds, foldExpanded],
  );
  useEffect(() => {
    setFoldExpanded(new Set());
  }, [currentFileDiff]);

  const allFoldsExpanded = folds.length > 0 && foldExpanded.size >= folds.length;
  const toggleFold = useCallback((foldIndex: number) => {
    setFoldExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(foldIndex)) next.delete(foldIndex);
      else next.add(foldIndex);
      return next;
    });
  }, []);
  const toggleExpandAll = useCallback(() => {
    setFoldExpanded((prev) =>
      prev.size >= folds.length ? new Set() : new Set(folds.map((_, i) => i)),
    );
  }, [folds]);

  /** 切换忽略空白：先记录滚动位置，重载后恢复（docs/11 §三 6.6）。 */
  const onToggleIgnoreWhitespace = useCallback(() => {
    restoreScrollRef.current = scrollRef.current?.scrollTop ?? 0;
    void setDiffIgnoreWhitespace(!ignoreWhitespace);
  }, [ignoreWhitespace, setDiffIgnoreWhitespace]);

  /** 复制选中的 diff 片段（按选区键生成 +/- 前缀行，docs/11 §三 6.8）。 */
  const onCopySelectionSnippet = useCallback(() => {
    const diff = useAppStore.getState().currentFileDiff;
    if (!diff || highlightedKeys.size === 0) return;
    const lines: string[] = [];
    for (let i = 0; i < diff.rows.length; i++) {
      const row = diff.rows[i];
      if (row.left?.kind === "removed" && highlightedKeys.has(lineSelectionKey(i, "old"))) {
        lines.push(`-${row.left.content}`);
      }
      if (row.right?.kind === "added" && highlightedKeys.has(lineSelectionKey(i, "new"))) {
        lines.push(`+${row.right.content}`);
      }
    }
    if (lines.length === 0) return;
    if (!copyText(lines.join("\n"))) {
      useAppStore.setState({ error: "复制失败：剪贴板不可用" });
    }
  }, [highlightedKeys]);

  /** 文件路径右键菜单：编辑器 / Finder / 复制路径 / 生成补丁（docs/11 §三 6.7 / 6.8）。 */
  const onPathContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const state = useAppStore.getState();
      const repo = state.repo;
      const path = state.diffFiles[state.selectedDiffFileIndex]?.path;
      if (!repo || !path) return;
      // 编辑器定位行：首个选中变更行，否则第一处变更。
      const firstSel = [...highlightedKeys][0];
      const selRow = firstSel ? Number(firstSel.slice(0, firstSel.indexOf(":"))) : NaN;
      const firstChange = state.currentFileDiff?.changeRowIndices[0];
      const anchorRow = Number.isInteger(selRow) ? selRow : (firstChange ?? NaN);
      const anchor = state.currentFileDiff?.rows[anchorRow];
      const line = anchor?.right?.lineno ?? anchor?.left?.lineno ?? null;
      const canPatch = state.diffScope?.kind === "workdir" || state.diffScope?.kind === "staged";
      openFileContextMenu(fileMenu.open, e, {
        repoId: repo.id,
        path,
        line,
        extra: canPatch
          ? [
              {
                key: "copy-patch",
                label: "生成并复制补丁（patch）",
                onSelect: () => {
                  void api
                    .generateFilePatch(repo.id, state.diffScope!, path)
                    .then((patch) => {
                      if (!copyText(patch)) {
                        useAppStore.setState({ error: "复制补丁失败：剪贴板不可用" });
                      } else {
                        useAppStore.setState({ notice: `已复制 ${path} 的补丁文本` });
                      }
                    })
                    .catch((err) =>
                      useAppStore.setState({ error: reportError("generateFilePatch", err) }),
                    );
                },
              },
            ]
          : undefined,
      });
    },
    [fileMenu, highlightedKeys],
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
        ignoreWhitespace={ignoreWhitespace}
        onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
        foldCount={folds.length}
        allFoldsExpanded={allFoldsExpanded}
        onToggleExpandAll={toggleExpandAll}
        onPrevFile={prevDiffFile}
        onNextFile={nextDiffFile}
        onSelectFile={showDiffFile}
        onOpenBlame={
          canBlame && blameTargetPath
            ? () => void openFileBlame(blameTargetPath, blameCommitId, { returnView: "diff" })
            : undefined
        }
        onClose={goBackToLog}
        onPathContextMenu={onPathContextMenu}
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
              onClick={onCopySelectionSnippet}
            >
              复制所选片段
            </button>
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
            layout={layout}
            onToggleFold={toggleFold}
            scrollRef={scrollRef}
            restoreScroll={restoreScrollRef}
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
            layout={layout}
            onToggleFold={toggleFold}
            scrollRef={scrollRef}
            restoreScroll={restoreScrollRef}
          />
        )}
      </div>
      {fileMenu.render()}
    </section>
  );
}

export default DiffView;
