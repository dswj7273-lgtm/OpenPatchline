/**
 * 虚拟滚动提交列表（docs/06 §3.2）。
 *
 * - 固定行高 ROW_H，仅渲染可见窗口 ± OVERSCAN 行（绝对定位）；
 * - 图形列由 <CommitGraph> 的单个 canvas 负责绘制，行内图形格保持透明；
 * - 滚动接近底部（剩 600px）时自动加载下一页；
 * - 过滤条件变化导致首页 commit 变化时，自动回到顶部。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, UIEvent } from "react";
import { useAppStore } from "../../store/app";
import type { CommitGraphRow, RefLabel } from "../../types";
import { CommitGraph, OVERSCAN, ROW_H, computeGraphWidth } from "./CommitGraph";
import "./CommitTable.css";

/** 距底部剩余多少像素时触发加载下一页。 */
const LOAD_MORE_THRESHOLD = 600;

/** 相对时间（docs §3.2：Date 列，如 “3 小时前”）。 */
function formatRelative(tsSec: number): string {
  const diffSec = Math.floor(Date.now() / 1000) - tsSec;
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 30 * 86400) return `${Math.floor(diffSec / 86400)} 天前`;
  return formatAbsolute(tsSec);
}

/** 绝对时间（悬停 tooltip / 详情面板用）。 */
export function formatAbsolute(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 引用类别 → 徽章样式类（docs §3.2）。 */
function refBadgeClass(kind: RefLabel["kind"]): string {
  switch (kind) {
    case "head":
      return "badge badge-head";
    case "local":
      return "badge badge-local";
    case "remote":
      return "badge badge-remote";
    case "tag":
      return "badge badge-tag";
  }
}

export function CommitTable() {
  const rows = useAppStore((s) => s.graphRows);
  const selectedCommitId = useAppStore((s) => s.selectedCommitId);
  const selectCommit = useAppStore((s) => s.selectCommit);
  const loadMoreCommits = useAppStore((s) => s.loadMoreCommits);
  const hasMore = useAppStore((s) => s.hasMore);
  const graphLoading = useAppStore((s) => s.graphLoading);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalHeight = rows.length * ROW_H;
  const graphWidth = useMemo(() => computeGraphWidth(rows), [rows]);

  const firstIdRef = useRef<string | null>(null);
  useEffect(() => {
    const firstId = rows.length > 0 ? rows[0].commit.id : null;
    if (firstIdRef.current !== firstId) {
      firstIdRef.current = firstId;
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setScrollTop(0);
    }
  }, [rows]);

  const maybeLoadMore = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasMore || graphLoading) return;
    if (el.scrollTop + el.clientHeight > totalHeight - LOAD_MORE_THRESHOLD) {
      void loadMoreCommits();
    }
  }, [hasMore, graphLoading, totalHeight, loadMoreCommits]);

  useEffect(() => {
    maybeLoadMore();
  }, [maybeLoadMore]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    maybeLoadMore();
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const windowRows: { row: CommitGraphRow; index: number }[] = [];
  for (let i = start; i < end; i++) windowRows.push({ row: rows[i], index: i });

  return (
    <section
      className="commit-table"
      style={{ "--graph-col-w": `${graphWidth}px` } as CSSProperties}
      aria-label="提交列表"
    >
      <div className="commit-table-header" aria-hidden="true">
        <span className="cth-graph">泳道</span>
        <span className="cth-msg">提交信息</span>
        <span className="cth-author">作者</span>
        <span className="cth-date">时间</span>
      </div>
      <div
        className="commit-table-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="grid"
        aria-rowcount={rows.length}
        aria-label="提交历史"
      >
        <div className="commit-table-inner" style={{ height: totalHeight }}>
          <CommitGraph
            rows={rows}
            graphWidth={graphWidth}
            scrollTop={scrollTop}
            viewportH={viewportH}
          />
          {windowRows.map(({ row, index }) => (
            <div
              key={row.commit.id}
              className={row.commit.id === selectedCommitId ? "commit-row selected" : "commit-row"}
              style={{ top: index * ROW_H }}
              role="row"
              aria-rowindex={index + 1}
              onClick={() => void selectCommit(row.commit.id)}
            >
              <span className="ct-graph" aria-hidden="true" />
              <div className="ct-content" role="presentation">
                <div className="ct-msg" role="gridcell" title={row.commit.message}>
                  <span className="ct-hash">{row.commit.shortId}</span>
                  <span className="ct-msg-text">{row.commit.message}</span>
                  {row.commit.refs.map((ref) => (
                    <span key={`${ref.kind}:${ref.name}`} className={refBadgeClass(ref.kind)}>
                      {ref.name}
                    </span>
                  ))}
                </div>
                <span className="ct-author" role="gridcell" title={row.commit.authorName}>
                  {row.commit.authorName}
                </span>
                <span
                  className="ct-date"
                  role="gridcell"
                  title={formatAbsolute(row.commit.timestamp)}
                >
                  {formatRelative(row.commit.timestamp)}
                </span>
              </div>
            </div>
          ))}
        </div>
        {rows.length === 0 && (
          <div className="commit-table-empty">
            {graphLoading ? "加载提交历史…" : "暂无匹配的提交"}
          </div>
        )}
      </div>
    </section>
  );
}
