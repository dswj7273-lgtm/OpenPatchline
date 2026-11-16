/**
 * 分栏 / 统一 diff 虚拟滚动网格 — docs/05 §11 / docs/06 §4。
 *
 * 单一滚动容器 + 绝对定位行（ROW_H = 20px），只渲染可视窗口
 * ±OVERSCAN 行；左右两栏共享同一行集合，天然同步纵向滚动。
 * 行高必须与 CSS（.diff-row / .u-row 的 line-height）保持一致。
 *
 * 横向滚动自行实现（行号槽与分栏中缝始终固定）：
 * - 每侧一个横向偏移，经 CSS 变量 --diff-scroll-x-old / -new 平移代码轨道；
 * - 分栏模式支持「同步」（两侧一起滑动）与「独立」（只滑动指针所在一侧）；
 *   同步模式下按住 ⌥/Alt 滚动可临时只滑动单侧；
 * - 每侧底部有可拖拽的细滚动条。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import type { TokenSpan } from "../../highlighter/tokenizer";
import type { AlignedRow, RowCell } from "../../types";
import ChangeRail, {
  groupChangeBlocks,
  KIND_LABEL,
  type ChangeBlock,
  type ChangeKind,
} from "./ChangeRail";
import CodeCell, { CodeContent } from "./CodeCell";

/** 行高（px），对应 docs/06 §6 的 --code-line-height。 */
export const ROW_H = 20;

/** 可视区两侧各多渲染的行数。 */
const OVERSCAN = 30;

/** 跳转变更时，目标行上方预留的行数（留出上下文）。 */
const GOTO_PADDING_ROWS = 3;

/** 行号槽宽度（px），与 CSS grid-template-columns 一致。 */
const GUTTER_W = 50;

/** 代码内容左右内边距之和（px），与 .diff-cell__content padding 一致。 */
const CONTENT_PAD = 18;

/** 横向滚动到行尾后额外留白（px）。 */
const END_SLACK = 24;

/** 内容底部为横向滚动条预留的高度（px），避免遮挡最后一行。 */
const HSCROLL_RESERVE = 14;

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
  /** 左右两栏是否同步横向滚动。 */
  hLinked: boolean;
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
  width: number;
}

type HSide = "old" | "new";

/** 两侧横向偏移（px）。 */
interface HOffsets {
  old: number;
  new: number;
}

const ZERO_OFFSETS: HOffsets = { old: 0, new: 0 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 估算单行视觉列数（Tab 计 4 列，宽字符 / 中文计 2 列，ASCII 计 1 列）。 */
function visualCols(text: string): number {
  let cols = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9) cols += 4;
    else if (code > 0xff) cols += 2;
    else cols += 1;
  }
  return cols;
}

/** 某一侧（或两侧）所有行中的最大视觉列数。 */
function maxColsOf(rows: AlignedRow[], side: "left" | "right" | "both"): number {
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const { left, right } = rows[i];
    if (side !== "right" && left) max = Math.max(max, visualCols(left.content));
    if (side !== "left" && right) max = Math.max(max, visualCols(right.content));
  }
  return max;
}

/** 测量当前代码字体单个字符宽度（等宽字体，canvas 测量）。 */
function useCharWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(7.8);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    const m = ctx.measureText("0".repeat(100)).width / 100;
    if (m > 0) setW(m);
  }, [ref]);
  return w;
}

/**
 * 虚拟滚动公共逻辑：纵向滚动跟踪（rAF 节流）、可视范围计算、
 * 数据切换回到顶部、监听 goto-change 事件滚动到目标变更。
 */
function useDiffViewport(lineCount: number, changeIndices: number[], resetKey: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState<Viewport>({ scrollTop: 0, height: 0, width: 0 });
  const rafRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = ref.current;
      if (!el) return;
      setVp((p) =>
        p.scrollTop === el.scrollTop && p.height === el.clientHeight && p.width === el.clientWidth
          ? p
          : { scrollTop: el.scrollTop, height: el.clientHeight, width: el.clientWidth },
      );
    });
  }, []);

  // 首帧与容器尺寸变化时更新可视宽高。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setVp((p) =>
        p.height === el.clientHeight && p.width === el.clientWidth
          ? p
          : { ...p, height: el.clientHeight, width: el.clientWidth },
      );
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

  // 切换文件（数据身份变化）时定位：有变更 → 直接跳到第一处变更
  // （上方留 3 行上下文）；无变更 → 回到顶部。
  useEffect(() => {
    const el = ref.current;
    const firstChange = changeIndices[0];
    const top =
      firstChange !== undefined
        ? Math.max(0, firstChange * ROW_H - GOTO_PADDING_ROWS * ROW_H)
        : 0;
    if (el) el.scrollTop = top;
    setVp((p) => (p.scrollTop === top ? p : { ...p, scrollTop: top }));
  }, [resetKey, changeIndices]);

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
  return { ref, handleScroll, start, end, vp };
}

interface HScrollOptions {
  /** 分栏模式（两侧各自偏移）；统一模式只使用 old 偏移。 */
  split: boolean;
  linked: boolean;
  maxOld: number;
  maxNew: number;
  resetKey: unknown;
}

/**
 * 横向滚动：拦截触控板 / Shift+滚轮的横向分量，按指针所在侧
 * 更新偏移（同步模式两侧一起；独立模式或按住 ⌥/Alt 只动单侧）。
 * 偏移直接写入容器 CSS 变量（无需整表重渲染），同时更新状态驱动滚动条。
 */
function useHorizontalScroll(ref: RefObject<HTMLDivElement | null>, opts: HScrollOptions) {
  const [hx, setHx] = useState<HOffsets>(ZERO_OFFSETS);
  const hxRef = useRef<HOffsets>(ZERO_OFFSETS);
  /** 同步模式下未按单侧上限截断的共享滚动目标；独立偏移后置 null。 */
  const sharedXRef = useRef<number | null>(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const apply = useCallback(
    (next: HOffsets) => {
      const { maxOld, maxNew } = optsRef.current;
      const clamped: HOffsets = {
        old: clamp(next.old, 0, maxOld),
        new: clamp(next.new, 0, maxNew),
      };
      const cur = hxRef.current;
      if (clamped.old === cur.old && clamped.new === cur.new) return;
      hxRef.current = clamped;
      const el = ref.current;
      if (el) {
        el.style.setProperty("--diff-scroll-x-old", `${clamped.old}px`);
        el.style.setProperty("--diff-scroll-x-new", `${clamped.new}px`);
      }
      setHx(clamped);
    },
    [ref],
  );

  /** 设置某侧偏移（滚动条拖拽/点击）；同步模式两侧对齐到同一值。 */
  const scrollTo = useCallback(
    (side: HSide, value: number, independent = false) => {
      const { split, linked, maxOld, maxNew } = optsRef.current;
      const cur = hxRef.current;
      if (!split || (linked && !independent)) {
        const maxShared = split ? Math.max(maxOld, maxNew) : maxOld;
        const target = clamp(value, 0, maxShared);
        sharedXRef.current = target;
        apply({ old: target, new: target });
      } else {
        sharedXRef.current = null;
        apply(side === "old" ? { ...cur, old: value } : { ...cur, new: value });
      }
    },
    [apply],
  );

  /** 按增量滚动（滚轮/触控板）；同步模式共享进度，使较短侧触底后较长侧仍可继续。 */
  const scrollBy = useCallback(
    (side: HSide, dx: number, independent = false) => {
      const { split, linked, maxOld, maxNew } = optsRef.current;
      const cur = hxRef.current;
      if (!split || (linked && !independent)) {
        if (sharedXRef.current !== null) {
          const maxShared = split ? Math.max(maxOld, maxNew) : maxOld;
          const target = clamp(sharedXRef.current + dx, 0, maxShared);
          sharedXRef.current = target;
          apply({ old: target, new: target });
        } else {
          apply({ old: cur.old + dx, new: cur.new + dx });
        }
      } else {
        sharedXRef.current = null;
        apply(side === "old" ? { ...cur, old: cur.old + dx } : { ...cur, new: cur.new + dx });
      }
    },
    [apply],
  );

  // 滚轮 / 触控板横向滚动（需 passive: false 才能阻止浏览器默认行为）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      let dx = e.deltaX;
      const dy = e.deltaY;
      // 普通鼠标：Shift + 竖向滚轮 = 横向滚动。
      if (e.shiftKey && dx === 0) dx = dy;
      if (dx === 0) return;
      if (e.deltaMode === 1) dx *= 16;
      const rect = el.getBoundingClientRect();
      const { split } = optsRef.current;
      const side: HSide = !split || e.clientX - rect.left < el.clientWidth / 2 ? "old" : "new";
      scrollBy(side, dx, e.altKey);
      if (e.shiftKey || Math.abs(dx) >= Math.abs(dy)) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, scrollBy]);

  // 切换文件：横向偏移归零。
  useEffect(() => {
    sharedXRef.current = 0;
    apply(ZERO_OFFSETS);
  }, [opts.resetKey, apply]);

  // 可滚动范围变化（窗口缩放等）时重新夹取。
  useEffect(() => {
    if (sharedXRef.current !== null) {
      const maxShared = opts.split ? Math.max(opts.maxOld, opts.maxNew) : opts.maxOld;
      const target = clamp(sharedXRef.current, 0, maxShared);
      sharedXRef.current = target;
      apply({ old: target, new: target });
    } else {
      apply(hxRef.current);
    }
  }, [opts.split, opts.maxOld, opts.maxNew, apply]);

  // 从独立切回同步：右侧对齐到左侧。
  useEffect(() => {
    if (opts.linked) {
      const cur = hxRef.current;
      sharedXRef.current = cur.old;
      apply({ old: cur.old, new: cur.old });
    } else {
      sharedXRef.current = null;
    }
  }, [opts.linked, apply]);

  return { hx, scrollTo };
}

/** 单侧底部横向滚动条（可拖拽滑块，点击轨道翻页）。 */
function HScrollBar({
  left,
  width,
  viewW,
  max,
  value,
  label,
  onChange,
}: {
  left: number;
  width: number;
  /** 该侧可视代码宽度（px）。 */
  viewW: number;
  /** 最大偏移（px）。 */
  max: number;
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const dragRef = useRef<{ x: number; v: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  if (max <= 0 || width < 40) return null;

  const thumbW = Math.max(28, (width * viewW) / (viewW + max));
  const travel = Math.max(1, width - thumbW);
  const thumbLeft = travel * (value / max);

  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { x: e.clientX, v: value };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    onChange(d.v + ((e.clientX - d.x) * max) / travel);
  };
  const onThumbUp = () => {
    dragRef.current = null;
    setDragging(false);
  };
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const page = viewW * 0.85;
    onChange(x < thumbLeft ? value - page : value + page);
  };

  return (
    <div
      className={`diff-hscroll${dragging ? " is-dragging" : ""}`}
      style={{ left, width }}
      role="scrollbar"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      onPointerDown={onTrackDown}
    >
      <div
        className="diff-hscroll__thumb"
        style={{ width: thumbW, transform: `translateX(${thumbLeft}px)` }}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
      />
    </div>
  );
}

/** 滚动到目标行（留出上下文行，与 goto-change 一致）。 */
function useJumpHandlers(ref: React.RefObject<HTMLDivElement | null>) {
  const onJumpToRow = useCallback(
    (row: number) => {
      const el = ref.current;
      if (!el) return;
      el.scrollTo({
        top: Math.max(0, row * ROW_H - GOTO_PADDING_ROWS * ROW_H),
        behavior: "smooth",
      });
    },
    [ref],
  );
  /** 按比例滚动（0..1，导航条拖拽用；即时跟随，不做平滑）。 */
  const onScrollTo = useCallback(
    (fraction: number) => {
      const el = ref.current;
      if (!el) return;
      const scrollable = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.max(0, Math.min(scrollable, fraction * scrollable));
    },
    [ref],
  );
  return { onJumpToRow, onScrollTo };
}

/** 分栏视图：每行左右两个单元格（spacer 侧为斜纹占位）。 */
export default function SplitDiffGrid({
  rows,
  leftTokens,
  rightTokens,
  changeRowIndices,
  hLinked,
}: SplitDiffGridProps) {
  const { ref, handleScroll, start, end, vp } = useDiffViewport(rows.length, changeRowIndices, rows);
  const { onJumpToRow, onScrollTo } = useJumpHandlers(ref);
  const charW = useCharWidth(ref);

  // 每侧可视代码宽度与最大横向偏移。
  const colsOld = useMemo(() => maxColsOf(rows, "left"), [rows]);
  const colsNew = useMemo(() => maxColsOf(rows, "right"), [rows]);
  const half = Math.floor(vp.width / 2);
  const viewOld = Math.max(0, half - GUTTER_W);
  const viewNew = Math.max(0, vp.width - half - GUTTER_W);
  const maxOld = vp.width > 0 ? Math.max(0, colsOld * charW + CONTENT_PAD + END_SLACK - viewOld) : 0;
  const maxNew = vp.width > 0 ? Math.max(0, colsNew * charW + CONTENT_PAD + END_SLACK - viewNew) : 0;

  const { hx, scrollTo } = useHorizontalScroll(ref, {
    split: true,
    linked: hLinked,
    maxOld,
    maxNew,
    resetKey: rows,
  });

  // 变更块（连续变更行聚合）：修改对 / 纯新增 / 纯删除，供导航条着色。
  const blocks = useMemo<ChangeBlock[]>(() => {
    const kindOf = (i: number): ChangeKind => {
      const { left, right } = rows[i];
      if (left && right) return "modify";
      if (right) return "add";
      return "remove";
    };
    return groupChangeBlocks(changeRowIndices, kindOf);
  }, [changeRowIndices, rows]);

  // tooltip：优先新侧行号（对应编辑器里的目标位置）。
  const labelFor = useCallback(
    (b: ChangeBlock) => {
      const first = rows[b.start];
      const no = first?.right?.lineno ?? first?.left?.lineno;
      const at = no != null ? `第 ${no} 行起` : `第 ${b.start + 1} 行起`;
      return `${KIND_LABEL[b.kind]} · ${at} ${b.count} 行`;
    },
    [rows],
  );

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

  const hasHScroll = maxOld > 0 || maxNew > 0;

  return (
    <>
      <div className="diff-grid-wrap">
        <div className="diff-grid" ref={ref} onScroll={handleScroll} role="grid" aria-rowcount={rows.length}>
          <div
            className="diff-grid__sizer"
            style={{ height: rows.length * ROW_H + (hasHScroll ? HSCROLL_RESERVE : 0) }}
          >
            {items}
          </div>
        </div>
        <HScrollBar
          left={GUTTER_W + 4}
          width={viewOld - 10}
          viewW={viewOld}
          max={maxOld}
          value={hx.old}
          label="旧版本横向滚动"
          onChange={(v) => scrollTo("old", v)}
        />
        <HScrollBar
          left={half + GUTTER_W + 4}
          width={viewNew - 10}
          viewW={viewNew}
          max={maxNew}
          value={hx.new}
          label="新版本横向滚动"
          onChange={(v) => scrollTo("new", v)}
        />
      </div>
      <ChangeRail
        lineCount={rows.length}
        rowHeight={ROW_H}
        blocks={blocks}
        scrollTop={vp.scrollTop}
        viewportH={vp.height}
        onJumpToRow={onJumpToRow}
        onScrollTo={onScrollTo}
        labelFor={labelFor}
      />
    </>
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

  const { ref, handleScroll, start, end, vp } = useDiffViewport(lines.length, changeLineIndices, lines);
  const { onJumpToRow, onScrollTo } = useJumpHandlers(ref);
  const charW = useCharWidth(ref);

  const cols = useMemo(() => maxColsOf(rows, "both"), [rows]);
  const viewW = Math.max(0, vp.width - GUTTER_W * 2);
  const maxX = vp.width > 0 ? Math.max(0, cols * charW + CONTENT_PAD + END_SLACK - viewW) : 0;

  const { hx, scrollTo } = useHorizontalScroll(ref, {
    split: false,
    linked: true,
    maxOld: maxX,
    maxNew: maxX,
    resetKey: lines,
  });

  // 变更块：统一视图下修改对已拆成先删后增两行，连续聚合后自然记为 modify。
  const blocks = useMemo<ChangeBlock[]>(
    () =>
      groupChangeBlocks(changeLineIndices, (l) =>
        lines[l].cell.kind === "added" ? "add" : "remove",
      ),
    [changeLineIndices, lines],
  );

  const labelFor = useCallback(
    (b: ChangeBlock) => {
      const first = lines[b.start];
      const no = first?.oldNo ?? first?.newNo;
      const at = no != null ? `第 ${no} 行起` : `第 ${b.start + 1} 行起`;
      return `${KIND_LABEL[b.kind]} · ${at} ${b.count} 行`;
    },
    [lines],
  );

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
          <span className="diff-cell__track">
            <CodeContent
              content={line.cell.content}
              tokens={tokens}
              charRanges={line.cell.charRanges}
              side={line.side}
            />
          </span>
        </code>
      </div>,
    );
  }

  return (
    <>
      <div className="diff-grid-wrap">
        <div
          className="diff-grid"
          ref={ref}
          onScroll={handleScroll}
          role="grid"
          aria-rowcount={lines.length}
        >
          <div
            className="diff-grid__sizer"
            style={{ height: lines.length * ROW_H + (maxX > 0 ? HSCROLL_RESERVE : 0) }}
          >
            {items}
          </div>
        </div>
        <HScrollBar
          left={GUTTER_W * 2 + 4}
          width={viewW - 10}
          viewW={viewW}
          max={maxX}
          value={hx.old}
          label="横向滚动"
          onChange={(v) => scrollTo("old", v)}
        />
      </div>
      <ChangeRail
        lineCount={lines.length}
        rowHeight={ROW_H}
        blocks={blocks}
        scrollTop={vp.scrollTop}
        viewportH={vp.height}
        onJumpToRow={onJumpToRow}
        onScrollTo={onScrollTo}
        labelFor={labelFor}
      />
    </>
  );
}
