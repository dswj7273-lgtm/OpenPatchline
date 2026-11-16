/**
 * 变更概览导航条（IDEA / VS Code 滚动条变更标记风格）— docs/06 §4。
 *
 * - 把连续的变更行聚合成块，按行比例映射为右侧竖条上的彩色标记
 *   （绿 = 新增、红 = 删除、琥珀 = 修改对）；
 * - 点击标记 → 一键跳转到对应变更块；点击 / 拖拽空白区域 → 按比例滚动；
 * - 当前视口覆盖的变更块高亮；右侧附视口位置指示条。
 *
 * 挂在滚动容器旁（不随内容滚动），行高与 SplitDiffGrid 的 ROW_H 一致
 * （由调用方传入，避免循环依赖）。
 */

import { useEffect, useRef, useState } from "react";

/** 变更块类型。 */
export type ChangeKind = "add" | "remove" | "modify";

/** 一个连续变更块（行下标空间）。 */
export interface ChangeBlock {
  /** 起始行下标（含）。 */
  start: number;
  /** 连续变更行数。 */
  count: number;
  kind: ChangeKind;
}

/**
 * 把（升序的）变更行下标按连续性聚合成块；块内类型混合时记 `modify`。
 */
export function groupChangeBlocks(
  indices: number[],
  kindOf: (index: number) => ChangeKind,
): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let i = 0;
  while (i < indices.length) {
    const start = indices[i];
    let count = 0;
    const kinds = new Set<ChangeKind>();
    while (i < indices.length && indices[i] === start + count) {
      kinds.add(kindOf(indices[i]));
      count++;
      i++;
    }
    const kind: ChangeKind = kinds.size > 1 ? "modify" : ([...kinds][0] ?? "modify");
    blocks.push({ start, count, kind });
  }
  return blocks;
}

/** 变更类型的中文说明（tooltip / aria 用）。 */
export const KIND_LABEL: Record<ChangeKind, string> = {
  add: "新增",
  remove: "删除",
  modify: "修改",
};

export interface ChangeRailProps {
  /** 总行数。 */
  lineCount: number;
  /** 行高（px，与网格 ROW_H 一致）。 */
  rowHeight: number;
  /** 变更块列表。 */
  blocks: ChangeBlock[];
  /** 当前滚动偏移（px）。 */
  scrollTop: number;
  /** 视口高度（px）。 */
  viewportH: number;
  /** 跳转到指定行（网格负责滚动与上下文留白）。 */
  onJumpToRow: (row: number) => void;
  /** 按比例滚动（0..1，点击 / 拖拽空白区域）。 */
  onScrollTo: (fraction: number) => void;
  /** 生成块 tooltip 文案（如 “修改 · 第 45 行起 4 行”）。 */
  labelFor?: (block: ChangeBlock) => string;
}

/** 标记最小高度（px）：单行变更也要看得见、点得中。 */
const MIN_MARKER_H = 5;

/** 视口指示条最小高度（px）。 */
const MIN_THUMB_H = 24;

export default function ChangeRail({
  lineCount,
  rowHeight,
  blocks,
  scrollTop,
  viewportH,
  onJumpToRow,
  onScrollTo,
  labelFor,
}: ChangeRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railH, setRailH] = useState(0);
  const draggingRef = useRef(false);

  const visible = lineCount > 0 && blocks.length > 0;

  // 轨道自身高度（窗口缩放跟随）。注意：容器必须先渲染才能测量，
  // 因此“未测到高度”时仍渲染空容器，而不是返回 null。
  useEffect(() => {
    if (!visible) return;
    const el = railRef.current;
    if (!el) return;
    const measure = () => setRailH((p) => (p === el.clientHeight ? p : el.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  if (!visible) return null;

  const totalPx = lineCount * rowHeight;
  const scale = (px: number) => (px / totalPx) * railH;
  const scrollable = Math.max(0, totalPx - viewportH);

  // 视口指示条：位置映射到 [0, railH - thumbH]。
  const thumbH = Math.max(MIN_THUMB_H, Math.min(railH, scale(viewportH)));
  const thumbTop = scrollable > 0 ? (scrollTop / scrollable) * (railH - thumbH) : 0;

  // 视口覆盖的行范围 → 命中的块高亮。
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const lastVisible = Math.ceil((scrollTop + viewportH) / rowHeight);

  // 点击 / 拖拽空白：按比例滚动（把点击位置映射到滚动行程）。
  const fractionFromEvent = (e: React.PointerEvent) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onScrollTo(fractionFromEvent(e));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (draggingRef.current) onScrollTo(fractionFromEvent(e));
  };
  const onPointerUp = () => {
    draggingRef.current = false;
  };

  return (
    <div
      ref={railRef}
      className="diff-rail"
      aria-label="变更概览"
      onPointerDown={railH > 0 ? onPointerDown : undefined}
      onPointerMove={railH > 0 ? onPointerMove : undefined}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {railH > 0 &&
        blocks.map((b, i) => {
          const top = scale(b.start * rowHeight);
          const height = Math.max(MIN_MARKER_H, scale(b.count * rowHeight));
          const active = b.start <= lastVisible && b.start + b.count - 1 >= firstVisible;
          const label =
            labelFor?.(b) ?? `${KIND_LABEL[b.kind]} · 第 ${b.start + 1} 行起 ${b.count} 行`;
          return (
            <button
              key={i}
              type="button"
              className={`diff-rail__marker diff-rail__marker--${b.kind}${active ? " is-active" : ""}`}
              style={{ top, height }}
              title={label}
              aria-label={`跳转到：${label}`}
              /* 标记点击不触发轨道的比例滚动。 */
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onJumpToRow(b.start);
              }}
            />
          );
        })}
      {railH > 0 && (
        <span
          className="diff-rail__thumb"
          style={{ top: thumbTop, height: thumbH }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
