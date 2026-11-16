/**
 * Split Diff 视图 — docs/06 §4。
 *
 * 数据源：useAppStore 的 currentFileDiff / diffFiles /
 * selectedDiffFileIndex / diffLoading。无选中文件时显示占位提示；
 * 有 diff 时 = DiffHeader + （分栏 | 统一）虚拟滚动网格。
 */

import { useEffect, useMemo, useState } from "react";
import { extensionOf } from "../../highlighter/extensions";
import {
  EMPTY_SIDE_TOKENS,
  getCachedHighlight,
  requestHighlight,
  type SideTokens,
} from "../../highlighter/workerClient";
import { useAppStore } from "../../store/app";
import type { AlignedRow } from "../../types";
import { AlertIcon } from "../Icons";
import "./DiffView.css";
import "../../highlighter/tokens.css";
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

export function DiffView() {
  const currentFileDiff = useAppStore((s) => s.currentFileDiff);
  const diffFiles = useAppStore((s) => s.diffFiles);
  const selectedIndex = useAppStore((s) => s.selectedDiffFileIndex);
  const diffLoading = useAppStore((s) => s.diffLoading);
  const prevDiffFile = useAppStore((s) => s.prevDiffFile);
  const nextDiffFile = useAppStore((s) => s.nextDiffFile);
  const showDiffFile = useAppStore((s) => s.showDiffFile);
  const goBackToLog = useAppStore((s) => s.goBackToLog);

  const [mode, setMode] = useState<DiffMode>("split");
  const [hLinked, setHLinked] = useState(readHLinked);

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

  return (
    <section className="diff-view" aria-label="Diff 视图">
      <DiffHeader
        files={diffFiles}
        currentIndex={selectedIndex}
        diff={currentFileDiff}
        loading={diffLoading}
        mode={mode}
        onModeChange={setMode}
        hLinked={hLinked}
        onToggleHLinked={toggleHLinked}
        onPrevFile={prevDiffFile}
        onNextFile={nextDiffFile}
        onSelectFile={showDiffFile}
        onClose={goBackToLog}
      />
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
          />
        ) : (
          <UnifiedGrid rows={rows} leftTokens={tokens.left} rightTokens={tokens.right} />
        )}
      </div>
    </section>
  );
}

export default DiffView;
