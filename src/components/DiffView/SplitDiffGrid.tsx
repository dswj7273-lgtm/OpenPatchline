/**
 * 分栏 / 统一 diff 虚拟滚动网格 — docs/05 §11 / docs/06 §4。
 *
 * 单一滚动容器 + 绝对定位行（ROW_H = 20px），只渲染可视窗口
 * ±OVERSCAN 行；左右两栏共享同一行集合，天然同步滚动。
 * 行高必须与 CSS（.diff-row / .u-row 的 line-height）保持一致。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TokenSpan } from "../../highlighter/tokenizer";
import type { AlignedRow, RowCell } from "../../types";
import CodeCell, { CodeContent } from "./CodeCell";

/** 行高（px），对应 docs/06 §6 的 --code-line-height。 */
export const ROW_H = 20;

/** 可视区两侧各多渲染的行数。 */
const OVERSCAN = 30;

/** 跳转变更时，目标行上方预留的行数（留出上下文）。 */
const GOTO_PADDING_ROWS = 3;

/** DiffHeader 请求跳转到上 / 下一处变更的 window 事件名。 */
export const GOTO_CHANGE_EVENT = "openpatchline:goto-change";

/** goto-change 事件负载。 */
export interface GotoChangeDetail {
  direction: 1 | -1;
}

export interface SplitDiffGridProps {
  rows: AlignedRow[];
  /** 左侧逐行 token（下标与 rows 一致，spacer 行为空数组）。 */
  leftTokens: TokenSpan[][];
  rightTokens: TokenSpan[][];
  /** 变更行下标（导航用）。 */
  changeRowIndices: number[];
}

export interface UnifiedGridProps {
  rows: AlignedRow[];
  leftTokens: TokenSpan[][];
  rightTokens: TokenSpan[][];
}

/** 兜底空 token，避免每次渲染新建数组。 */
const EMPTY_TOKENS: TokenSpan[] = [];

/** 可视窗口状态。 */
interface Viewport {
  scrollTop: number;
  height: number;
}

/**
 * 虚拟滚动公共逻辑：滚动跟踪（rAF 节流）、可视范围计算、
 * 数据切换回到顶部、监听 goto-change 事件滚动到目标变更。
 */
function useDiffViewport(lineCount: number, changeIndices: number[], resetKey: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState<Viewport>({ scrollTop: 0, height: 0 });
  const rafRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = ref.current;
      if (el) setVp({ scrollTop: el.scrollTop, height: el.clientHeight });
    });
  }, []);

  // 首帧与容器尺寸变化时更新可视高度。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setVp((p) => (p.height === el.clientHeight ? p : { ...p, height: el.clientHeight }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 卸载时取消挂起的 rAF 回调。
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // 切换文件（数据身份变化）时回到顶部。
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = 0;
    setVp((p) => (p.scrollTop === 0 ? p : { ...p, scrollTop: 0 }));
  }, [resetKey]);

  // 跳转到上 / 下一处变更（DiffHeader 派发）。
  useEffect(() => {
    const onGoto = (e: Event) => {
      const dir = (e as CustomEvent<GotoChangeDetail>).detail?.direction;
      const el = ref.current;
      if (!dir || !el) return;
      const firstVisible = Math.floor(el.scrollTop / ROW_H);
      // 当前变更游标：最后一个 <= firstVisible 的变更行。
      let cur = -1;
      for (let k = 0; k < changeIndices.length; k++) {
        if (changeIndices[k] <= firstVisible) cur = k;
        else break;
      }
      let target: number | undefined;
      if (dir > 0) {
        target = changeIndices[cur + 1];
      } else if (cur >= 0) {
        // 已滚过当前变更头部则先回到它，否则去上一处。
        target = firstVisible > changeIndices[cur] ? changeIndices[cur] : changeIndices[cur - 1];
      }
      if (target === undefined) return;
      el.scrollTo({
        top: Math.max(0, target * ROW_H - GOTO_PADDING_ROWS * ROW_H),
        behavior: "smooth",
      });
    };
    window.addEventListener(GOTO_CHANGE_EVENT, onGoto);
    return () => window.removeEventListener(GOTO_CHANGE_EVENT, onGoto);
  }, [changeIndices]);

  const start = Math.max(0, Math.floor(vp.scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(lineCount, Math.ceil((vp.scrollTop + vp.height) / ROW_H) + OVERSCAN);
  return { ref, handleScroll, start, end };
}

/** 分栏视图：每行左右两个单元格（spacer 侧为斜纹占位）。 */
export default function SplitDiffGrid({
  rows,
  leftTokens,
  rightTokens,
  changeRowIndices,
}: SplitDiffGridProps) {
  const { ref, handleScroll, start, end } = useDiffViewport(rows.length, changeRowIndices, rows);

  const items: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    items.push(
      <div
        className="diff-row"
        role="row"
        aria-rowindex={i + 1}
        key={i}
        style={{ top: i * ROW_H }}
      >
        <CodeCell cell={row.left} side="old" tokens={leftTokens[i] ?? EMPTY_TOKENS} />
        <CodeCell cell={row.right} side="new" tokens={rightTokens[i] ?? EMPTY_TOKENS} />
      </div>,
    );
  }

  return (
    <div className="diff-grid" ref={ref} onScroll={handleScroll} role="grid" aria-rowcount={rows.length}>
      <div className="diff-grid__sizer" style={{ height: rows.length * ROW_H }}>
        {items}
      </div>
    </div>
  );
}

/** 统一视图的单行：旧 / 新行号 + 内容。 */
interface UnifiedLine {
  oldNo: number | null;
  newNo: number | null;
  cell: RowCell;
  /** 源 AlignedRow 下标（token 查找用）。 */
  rowIndex: number;
  side: "old" | "new";
}

/** 统一视图：上下文一行；修改对拆成先删后增两行；spacer 行跳过。 */
export function UnifiedGrid({ rows, leftTokens, rightTokens }: UnifiedGridProps) {
  const { lines, changeLineIndices } = useMemo(() => {
    const lines: UnifiedLine[] = [];
    const changes: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const { left, right } = rows[i];
      if (left && right) {
        if (left.kind === "context") {
          lines.push({ oldNo: left.lineno, newNo: right.lineno, cell: left, rowIndex: i, side: "old" });
        } else {
          // 修改对：先删除行后新增行。
          lines.push({ oldNo: left.lineno, newNo: null, cell: left, rowIndex: i, side: "old" });
          lines.push({ oldNo: null, newNo: right.lineno, cell: right, rowIndex: i, side: "new" });
        }
      } else if (left) {
        lines.push({ oldNo: left.lineno, newNo: null, cell: left, rowIndex: i, side: "old" });
      } else if (right) {
        lines.push({ oldNo: null, newNo: right.lineno, cell: right, rowIndex: i, side: "new" });
      }
      // 双 spacer 行（不应出现）直接跳过。
    }
    for (let l = 0; l < lines.length; l++) {
      if (lines[l].cell.kind !== "context") changes.push(l);
    }
    return { lines, changeLineIndices: changes };
  }, [rows]);

  const { ref, handleScroll, start, end } = useDiffViewport(lines.length, changeLineIndices, lines);

  const items: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const kindClass = line.cell.kind === "context" ? "" : ` u-row--${line.cell.kind}`;
    const tokens = (line.side === "old" ? leftTokens : rightTokens)[line.rowIndex] ?? EMPTY_TOKENS;
    items.push(
      <div
        className={`u-row${kindClass}`}
        role="row"
        aria-rowindex={i + 1}
        key={i}
        style={{ top: i * ROW_H }}
      >
        <span className="u-gutter">{line.oldNo ?? ""}</span>
        <span className="u-gutter">{line.newNo ?? ""}</span>
        <code className="diff-cell__content">
          <CodeContent
            content={line.cell.content}
            tokens={tokens}
            charRanges={line.cell.charRanges}
            side={line.side}
          />
        </code>
      </div>,
    );
  }

  return (
    <div
      className="diff-grid"
      ref={ref}
      onScroll={handleScroll}
      role="grid"
      aria-rowcount={lines.length}
    >
      <div className="diff-grid__sizer" style={{ height: lines.length * ROW_H }}>
        {items}
      </div>
    </div>
  );
}
