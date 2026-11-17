/**
 * Git Blame 视图（v0.5）：
 * - 虚拟滚动展示每行代码的最后修改提交、作者、相对时间与年龄热力条；
 * - 连续同提交行自动合并展示元数据，复用 Web Worker 异步语法高亮；
 * - 点击行/提交槽可查看提交摘要、定位提交树、打开该提交 Diff 或向父提交历史钻取 Blame。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { extensionOf } from "../../highlighter/extensions";
import type { TokenSpan } from "../../highlighter/tokenizer";
import {
  EMPTY_SIDE_TOKENS,
  getCachedHighlight,
  requestHighlight,
} from "../../highlighter/workerClient";
import { useAppStore } from "../../store/app";
import type { BlameCommitInfo, BlameLine } from "../../types";
import { CodeContent } from "../DiffView/CodeCell";
import { formatAbsolute, formatRelative } from "../GitLogView/CommitTable";
import {
  AlertIcon,
  ArrowLeftIcon,
  CloseIcon,
  CommitIcon,
  CompareIcon,
  HistoryIcon,
} from "../Icons";
import "./BlameView.css";
import "../../highlighter/tokens.css";

const ROW_HEIGHT = 20;
const OVERSCAN = 15;

/** 根据文件内所有提交时间戳计算归一化年龄权重（0 = 最旧，1 = 最新）。 */
function computeCommitAges(commits: Record<string, BlameCommitInfo>): Map<string, number> {
  const timestamps = Object.values(commits)
    .filter((c) => !c.isUncommitted && c.timestamp > 0)
    .map((c) => c.timestamp);
  const ages = new Map<string, number>();
  if (timestamps.length === 0) return ages;
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const span = Math.max(1, maxTs - minTs);
  for (const c of Object.values(commits)) {
    if (c.isUncommitted) {
      ages.set(c.id, 1);
    } else if (c.timestamp <= 0) {
      ages.set(c.id, 0);
    } else {
      ages.set(c.id, (c.timestamp - minTs) / span);
    }
  }
  return ages;
}

export function BlameView() {
  const blameResult = useAppStore((s) => s.blameResult);
  const blameLoading = useAppStore((s) => s.blameLoading);
  const blameHistory = useAppStore((s) => s.blameHistory);
  const blameReturnView = useAppStore((s) => s.blameReturnView);
  const openFileBlame = useAppStore((s) => s.openFileBlame);
  const goBackBlame = useAppStore((s) => s.goBackBlame);
  const closeBlame = useAppStore((s) => s.closeBlame);
  const goBackToLog = useAppStore((s) => s.goBackToLog);
  const selectCommit = useAppStore((s) => s.selectCommit);
  const openFileDiff = useAppStore((s) => s.openFileDiff);

  const [selectedLine, setSelectedLine] = useState<BlameLine | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedLine(null);
    setScrollTop(0);
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = 0;
    }
  }, [blameResult]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight || 600);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [blameResult]);

  const fullText = useMemo(
    () => (blameResult ? blameResult.lines.map((l) => l.content).join("\n") : ""),
    [blameResult],
  );
  const langId = useMemo(() => (blameResult ? extensionOf(blameResult.path) : ""), [blameResult]);

  const [asyncTokens, setAsyncTokens] = useState<{
    key: object | null;
    tokens: TokenSpan[][];
    degraded: boolean;
  }>({ key: null, tokens: [], degraded: false });

  const cachedTokens = useMemo(() => {
    if (
      !blameResult ||
      blameResult.isBinary ||
      blameResult.tooLarge ||
      blameResult.lines.length === 0
    ) {
      return EMPTY_SIDE_TOKENS;
    }
    return getCachedHighlight(fullText, "", langId);
  }, [blameResult, fullText, langId]);

  useEffect(() => {
    if (
      !blameResult ||
      blameResult.isBinary ||
      blameResult.tooLarge ||
      blameResult.lines.length === 0 ||
      cachedTokens !== null
    ) {
      return;
    }
    const key = blameResult;
    return requestHighlight(fullText, "", langId, (res) => {
      setAsyncTokens({ key, tokens: res.left, degraded: res.degraded });
    });
  }, [blameResult, fullText, langId, cachedTokens]);

  const lineTokens =
    cachedTokens?.left ?? (asyncTokens.key === blameResult ? asyncTokens.tokens : []);
  const degraded =
    cachedTokens?.degraded ?? (asyncTokens.key === blameResult ? asyncTokens.degraded : false);

  const commitAges = useMemo(
    () => (blameResult ? computeCommitAges(blameResult.commits) : new Map<string, number>()),
    [blameResult],
  );

  if (!blameResult) {
    return (
      <section className="blame-view blame-view--empty" aria-label="Blame 视图">
        <p className="blame-placeholder">{blameLoading ? "正在计算逐行 Blame…" : "未选择文件"}</p>
      </section>
    );
  }

  const lines = blameResult.lines;
  const totalHeight = lines.length * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(lines.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visibleLines = lines.slice(startIdx, endIdx);
  const uniqueCommits = Object.keys(blameResult.commits).length;

  const selectedCommit: BlameCommitInfo | null = selectedLine
    ? (blameResult.commits[selectedLine.commitId] ?? null)
    : null;
  const activeCommitId = selectedLine?.commitId ?? null;

  const inspectCommitInLog = (commitId: string) => {
    goBackToLog();
    void selectCommit(commitId);
  };

  const inspectCommitDiff = (line: BlameLine, commitId: string) => {
    const filePath = line.origPath ?? blameResult.path;
    void openFileDiff(
      { kind: "commit", commitId },
      [
        {
          path: filePath,
          oldPath: null,
          changeType: "modified",
          additions: 0,
          deletions: 0,
        },
      ],
      0,
    );
  };

  const drillParentBlame = (line: BlameLine, parentId: string) => {
    const filePath = line.origPath ?? blameResult.path;
    void openFileBlame(filePath, parentId, { pushHistory: true });
  };

  return (
    <section className="blame-view" aria-label="Blame 视图">
      <header className="blame-header">
        <div className="blame-header-left">
          {blameHistory.length > 0 && (
            <button
              type="button"
              className="btn blame-btn"
              title="返回上一版本 Blame"
              onClick={() => void goBackBlame()}
            >
              <ArrowLeftIcon />
              <span>上一版本</span>
            </button>
          )}
          <span className="blame-badge-title">Blame</span>
          <span className="blame-path" title={blameResult.path}>
            {blameResult.path}
          </span>
          <span className="blame-ref-pill">
            {blameResult.commitId ? blameResult.commitId.slice(0, 7) : "工作区 / HEAD"}
          </span>
          <span className="blame-stats">
            {lines.length} 行 · {uniqueCommits} 次提交
          </span>
        </div>

        <div className="blame-header-right">
          {blameLoading && <span className="blame-loading">加载中…</span>}
          {blameResult.commitId !== null && (
            <button
              type="button"
              className="btn blame-btn"
              title="切换到当前工作区/HEAD 版本的 Blame"
              onClick={() => void openFileBlame(blameResult.path, null, { pushHistory: true })}
            >
              <HistoryIcon />
              <span>回到最新</span>
            </button>
          )}
          <button type="button" className="btn blame-btn" onClick={closeBlame}>
            {blameReturnView === "diff" ? "返回 Diff" : "返回日志"}
          </button>
          <button
            type="button"
            className="blame-icon-btn"
            aria-label="关闭 Blame 视图"
            title="关闭 Blame 视图 (Esc)"
            onClick={closeBlame}
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      {degraded && (
        <div className="blame-banner" role="status">
          <AlertIcon />
          <span>文件行数或单行长度超出阈值，已对语法高亮降级以保持滚动流畅</span>
        </div>
      )}

      {selectedLine && selectedCommit && (
        <div className="blame-inspector" role="region" aria-label="选中行提交详情">
          <div className="blame-inspector-meta">
            <CommitIcon />
            <code className="blame-inspector-hash">{selectedCommit.shortId}</code>
            <span className="blame-inspector-summary" title={selectedCommit.summary}>
              {selectedCommit.summary || "（无提交说明）"}
            </span>
            <span className="blame-inspector-author">
              {selectedCommit.authorName}
              {!selectedCommit.isUncommitted && selectedCommit.timestamp > 0 && (
                <> · {formatAbsolute(selectedCommit.timestamp)}</>
              )}
            </span>
            {selectedLine.origPath && (
              <span className="blame-inspector-rename" title={`原路径: ${selectedLine.origPath}`}>
                原路径: {selectedLine.origPath} (第 {selectedLine.origLineNo} 行)
              </span>
            )}
          </div>
          {!selectedCommit.isUncommitted && (
            <div className="blame-inspector-actions">
              <button
                type="button"
                className="btn blame-btn"
                onClick={() => inspectCommitDiff(selectedLine, selectedCommit.id)}
              >
                <CompareIcon />
                <span>查看提交 Diff</span>
              </button>
              <button
                type="button"
                className="btn blame-btn"
                onClick={() => inspectCommitInLog(selectedCommit.id)}
              >
                <span>在提交树中定位</span>
              </button>
              {selectedCommit.parentIds.length > 0 && (
                <button
                  type="button"
                  className="btn btn-primary blame-btn"
                  title="查看该提交的父提交中此文件对应的 Blame"
                  onClick={() => drillParentBlame(selectedLine, selectedCommit.parentIds[0])}
                >
                  <HistoryIcon />
                  <span>追溯父提交 Blame</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="blame-body">
        {blameResult.isBinary ? (
          <p className="blame-placeholder">二进制文件，无法显示逐行 Blame</p>
        ) : blameResult.tooLarge ? (
          <p className="blame-placeholder">
            文件过大（超过 2MB 或 20,000 行），暂不支持 Blame 展示
          </p>
        ) : lines.length === 0 ? (
          <p className="blame-placeholder">文件为空</p>
        ) : (
          <div
            ref={scrollerRef}
            className="blame-scroller"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div className="blame-canvas" style={{ height: totalHeight }}>
              <div
                className="blame-window"
                style={{ transform: `translateY(${startIdx * ROW_HEIGHT}px)` }}
              >
                {visibleLines.map((line, i) => {
                  const globalIdx = startIdx + i;
                  const prev = globalIdx > 0 ? lines[globalIdx - 1] : null;
                  const isHunkStart = !prev || prev.commitId !== line.commitId;
                  const commit = blameResult.commits[line.commitId];
                  const age = commitAges.get(line.commitId) ?? 0.3;
                  const isActive = activeCommitId === line.commitId;
                  const titleText = commit
                    ? commit.isUncommitted
                      ? "尚未提交的本地修改"
                      : `${commit.shortId} · ${commit.authorName} · ${formatAbsolute(commit.timestamp)}\n${commit.summary}`
                    : "";

                  return (
                    <div
                      key={line.lineNo}
                      className={`blame-row${isHunkStart ? " is-hunk-start" : ""}${isActive ? " is-active" : ""}${commit?.isUncommitted ? " is-uncommitted" : ""}`}
                      style={{ height: ROW_HEIGHT }}
                    >
                      <button
                        type="button"
                        className="blame-gutter"
                        title={titleText}
                        onClick={() => setSelectedLine(line)}
                      >
                        <span
                          className="blame-age-bar"
                          style={{ opacity: commit?.isUncommitted ? 0.95 : 0.2 + age * 0.8 }}
                          aria-hidden="true"
                        />
                        {isHunkStart ? (
                          <>
                            <span className="blame-hash">
                              {commit?.isUncommitted ? "未提交" : (commit?.shortId ?? "-------")}
                            </span>
                            <span className="blame-author">{commit?.authorName ?? "Unknown"}</span>
                            <span className="blame-date">
                              {commit && !commit.isUncommitted && commit.timestamp > 0
                                ? formatRelative(commit.timestamp)
                                : "工作区"}
                            </span>
                          </>
                        ) : (
                          <span className="blame-gutter-cont" aria-hidden="true" />
                        )}
                      </button>
                      <span className="blame-ln">{line.lineNo}</span>
                      <span className="blame-code">
                        <CodeContent
                          content={line.content}
                          tokens={lineTokens[globalIdx] ?? []}
                          charRanges={[]}
                          side="new"
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default BlameView;
