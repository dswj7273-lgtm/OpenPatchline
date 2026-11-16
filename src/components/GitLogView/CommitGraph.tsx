/**
 * 提交图 Canvas（docs/06 §3.3）。
 *
 * 单个绝对定位 canvas 覆盖图形列（宽度随活跃泳道数自适应），置于行背景之上，
 * 节点圆点外环通过 destination-out 镂空，让正常/悬停/选中行背景自然透出。
 * 每次只绘制可见窗口 ± 超量行，滚动 / 视口尺寸 / 主题 / 选中项变化时经
 * requestAnimationFrame 重绘。
 *
 * 整图高度超过 canvas 后备存储安全上限（WebKit 单边 65535）时自动切换为
 * “窗口模式”，避免深滚动后画布超限变空白。
 */
import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/app";
import type { CommitGraphRow, Connection } from "../../types";
import "./CommitGraph.css";

/** 行高（px），提交列表与图形共用。 */
export const ROW_H = 34;
/** 可见窗口外的超量渲染行数（与 CommitTable 一致）。 */
export const OVERSCAN = 25;
/** 泳道水平间距（px）。 */
const LANE_GAP = 12;
/** 第 0 泳道中心 X 偏移（圆点半径 ~4px，左缘 14px 与表头文字对齐）。 */
const LANE_OFFSET_X = 18;
/** 最小图形列宽（px）。 */
const MIN_GRAPH_W = 52;
/** 最大回绕泳道数。 */
const MAX_LANES = 8;
/** canvas 后备存储单边安全上限（WebKit 上限 65535，留余量）。 */
const MAX_BACKING = 32000;

/** 根据当前已加载行计算自适应泳道列宽（px）。 */
export function computeGraphWidth(rows: CommitGraphRow[]): number {
  let maxLanes = 1;
  for (const row of rows) {
    const lanes = Math.max(row.laneCount, row.laneIndex + 1);
    if (lanes > maxLanes) maxLanes = lanes;
    if (maxLanes >= MAX_LANES) break;
  }
  const clamped = Math.min(MAX_LANES, Math.max(1, maxLanes));
  return Math.max(MIN_GRAPH_W, clamped * LANE_GAP + 26);
}

/** 泳道 x 坐标；超过 8 条泳道时回绕，保证圆点及选中环不越出列宽。 */
function laneX(lane: number): number {
  return (((lane % MAX_LANES) + MAX_LANES) % MAX_LANES) * LANE_GAP + LANE_OFFSET_X;
}

/** 深色主题泳道兜底色板（与 theme.css 的 --graph-lane-0..7 一致）。 */
const FALLBACK_PALETTE: readonly string[] = [
  "oklch(68% 0.150 262)",
  "oklch(69% 0.145 302)",
  "oklch(71% 0.130 200)",
  "oklch(74% 0.138 70)",
  "oklch(69% 0.140 162)",
  "oklch(68% 0.148 350)",
  "oklch(71% 0.135 232)",
  "oklch(71% 0.142 38)",
];

/** 读取当前主题泳道色板。 */
function readThemePalette(): string[] {
  const style = getComputedStyle(document.documentElement);
  const palette: string[] = [];
  for (let i = 0; i < MAX_LANES; i++) {
    const value = style.getPropertyValue(`--graph-lane-${i}`).trim();
    palette.push(value || FALLBACK_PALETTE[i]);
  }
  return palette;
}

/** 画一段连线：同泳道竖线，跨泳道平滑贝塞尔曲线。 */
function strokeConnection(
  ctx: CanvasRenderingContext2D,
  conn: Connection,
  y1: number,
  y2: number,
  palette: string[],
): void {
  const x1 = laneX(conn.fromLane);
  const x2 = laneX(conn.toLane);
  ctx.strokeStyle = palette[conn.colorIndex % MAX_LANES];
  ctx.lineWidth = 1.65;
  ctx.globalAlpha = 0.82;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  if (x1 === x2) {
    ctx.lineTo(x2, y2);
  } else {
    const midY = (y1 + y2) / 2;
    ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function draw(
  canvas: HTMLCanvasElement | null,
  rows: CommitGraphRow[],
  graphWidth: number,
  scrollTop: number,
  viewportH: number,
  selectedCommitId: string | null,
): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const totalH = rows.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  if (end <= start) {
    canvas.style.height = "0px";
    canvas.style.top = "0px";
    canvas.width = 0;
    canvas.height = 0;
    return;
  }

  const full = totalH * dpr <= MAX_BACKING;
  const topY = full ? 0 : start * ROW_H;
  const cssH = full ? totalH : (end - start) * ROW_H;

  const backingW = Math.round(graphWidth * dpr);
  const backingH = Math.round(cssH * dpr);
  if (canvas.width !== backingW) canvas.width = backingW;
  if (canvas.height !== backingH) canvas.height = backingH;
  canvas.style.width = `${graphWidth}px`;
  canvas.style.height = `${cssH}px`;
  canvas.style.top = `${topY}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, graphWidth, cssH);
  ctx.lineCap = "round";

  const palette = readThemePalette();
  const yOf = (i: number) => i * ROW_H + ROW_H / 2 - topY;

  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    for (const conn of row.connectionsBelow) {
      const y2 = i + 1 < rows.length ? yOf(i + 1) : cssH;
      strokeConnection(ctx, conn, yOf(i), y2, palette);
    }
  }

  const firstRow = rows[start];
  if (firstRow) {
    const y1 = start > 0 ? yOf(start - 1) : 0;
    for (const conn of firstRow.connectionsAbove) {
      strokeConnection(ctx, conn, y1, yOf(start), palette);
    }
  }

  // 节点圆点：使用 destination-out 镂空透明外环，透出下方正常/悬停/选中行背景。
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    const cx = laneX(row.laneIndex);
    const cy = yOf(i);
    const color = palette[row.colorIndex % MAX_LANES];
    const isSelected = row.commit.id === selectedCommitId;

    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(cx, cy, isSelected ? 6.2 : 5.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    if (isSelected) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, isSelected ? 4.2 : 3.7, 0, Math.PI * 2);
    ctx.fill();
  }
}

interface CommitGraphProps {
  rows: CommitGraphRow[];
  graphWidth: number;
  scrollTop: number;
  viewportH: number;
}

export function CommitGraph({ rows, graphWidth, scrollTop, viewportH }: CommitGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const theme = useAppStore(s => s.theme);
  const selectedCommitId = useAppStore(s => s.selectedCommitId);

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      draw(canvasRef.current, rows, graphWidth, scrollTop, viewportH, selectedCommitId),
    );
    return () => cancelAnimationFrame(raf);
  }, [rows, graphWidth, scrollTop, viewportH, theme, selectedCommitId]);

  return (
    <canvas ref={canvasRef} className="commit-graph-canvas" role="img" aria-label="提交历史泳道图" />
  );
}
