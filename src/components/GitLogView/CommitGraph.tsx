/**
 * 提交图 Canvas（docs/06 §3.3）。
 *
 * 单个绝对定位 canvas 覆盖图形列（宽 90px），置于行内容之下（行内图形格
 * 保持透明，节点圆点也由 canvas 绘制）。每次只绘制可见窗口 ± 超量行，
 * 滚动 / 视口尺寸 / 主题变化时经 requestAnimationFrame 重绘。
 *
 * 整图高度超过 canvas 后备存储安全上限（WebKit 单边 65535）时自动切换为
 * “窗口模式”：canvas 高度改为窗口高度并跟随可见窗口平移（top 与重绘在
 * 同一 rAF 内原子更新，与行内容始终对齐），避免深滚动后画布超限变空白。
 */
import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/app";
import type { CommitGraphRow, Connection } from "../../types";
import "./CommitGraph.css";

/** 图形列宽度（px），与 .ct-graph / .cth-graph 对齐。 */
export const GRAPH_W = 90;
/** 行高（px），提交列表与图形共用。 */
export const ROW_H = 30;
/** 可见窗口外的超量渲染行数（与 CommitTable 一致）。 */
export const OVERSCAN = 25;
/** 泳道水平间距（px）。 */
const LANE_GAP = 11;
/** canvas 后备存储单边安全上限（WebKit 上限 65535，留余量）。 */
const MAX_BACKING = 32000;

/** 泳道 x 坐标；超过 8 条泳道时回绕，保证不越出列宽。 */
function laneX(lane: number): number {
  return (((lane % 8) + 8) % 8) * LANE_GAP + LANE_GAP / 2;
}

/** 深色主题泳道兜底色板（与 theme.css 的 --graph-lane-0..7 一致）。 */
const FALLBACK_PALETTE: readonly string[] = [
  "oklch(65% 0.180 145)",
  "oklch(65% 0.180 260)",
  "oklch(65% 0.180 30)",
  "oklch(65% 0.180 300)",
  "oklch(65% 0.180 200)",
  "oklch(65% 0.180 60)",
  "oklch(65% 0.180 0)",
  "oklch(65% 0.180 180)",
];

/** 优先读取当前主题的 CSS 变量，取不到时退回兜底色板。 */
function readPalette(): string[] {
  const style = getComputedStyle(document.documentElement);
  const palette: string[] = [];
  for (let i = 0; i < 8; i++) {
    const value = style.getPropertyValue(`--graph-lane-${i}`).trim();
    palette.push(value || FALLBACK_PALETTE[i]);
  }
  return palette;
}

/** 画一段连线：同泳道竖线，跨泳道二次贝塞尔（控制点位于中线高度）。 */
function strokeConnection(
  ctx: CanvasRenderingContext2D,
  conn: Connection,
  y1: number,
  y2: number,
  palette: string[],
): void {
  const x1 = laneX(conn.fromLane);
  const x2 = laneX(conn.toLane);
  ctx.strokeStyle = palette[conn.colorIndex % 8];
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  if (x1 === x2) {
    ctx.lineTo(x2, y2);
  } else {
    ctx.quadraticCurveTo(x2, (y1 + y2) / 2, x2, y2);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function draw(
  canvas: HTMLCanvasElement | null,
  rows: CommitGraphRow[],
  scrollTop: number,
  viewportH: number,
): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const totalH = rows.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  if (end <= start) {
    // 无可绘制内容：收缩为 0 高避免残留旧像素。
    canvas.style.height = "0px";
    canvas.style.top = "0px";
    canvas.width = 0;
    canvas.height = 0;
    return;
  }

  const full = totalH * dpr <= MAX_BACKING;
  const topY = full ? 0 : start * ROW_H;
  const cssH = full ? totalH : (end - start) * ROW_H;

  const backingW = Math.round(GRAPH_W * dpr);
  const backingH = Math.round(cssH * dpr);
  if (canvas.width !== backingW) canvas.width = backingW;
  if (canvas.height !== backingH) canvas.height = backingH;
  canvas.style.width = `${GRAPH_W}px`;
  canvas.style.height = `${cssH}px`;
  canvas.style.top = `${topY}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, GRAPH_W, cssH);
  ctx.lineCap = "round";

  const palette = readPalette();
  const yOf = (i: number) => i * ROW_H + ROW_H / 2 - topY;

  // 连线：每行向下一段（末行延伸到画布底边，暗示未加载的历史）。
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    for (const conn of row.connectionsBelow) {
      const y2 = i + 1 < rows.length ? yOf(i + 1) : cssH;
      strokeConnection(ctx, conn, yOf(i), y2, palette);
    }
  }
  // 窗口上缘：补画首个可见行上方的连线，避免顶部断线
  // （完整高度模式下画完整段；窗口模式下超出画布顶即呈现为通到顶边的短线）。
  const firstRow = rows[start];
  if (firstRow) {
    const y1 = start > 0 ? yOf(start - 1) : 0;
    for (const conn of firstRow.connectionsAbove) {
      strokeConnection(ctx, conn, y1, yOf(start), palette);
    }
  }

  // 节点：提交圆点（颜色取该提交的泳道颜色索引）。
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    ctx.fillStyle = palette[row.colorIndex % 8];
    ctx.beginPath();
    ctx.arc(laneX(row.laneIndex), yOf(i), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

interface CommitGraphProps {
  rows: CommitGraphRow[];
  /** 滚动容器当前 scrollTop（决定绘制窗口）。 */
  scrollTop: number;
  /** 滚动容器视口高度。 */
  viewportH: number;
}

export function CommitGraph({ rows, scrollTop, viewportH }: CommitGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const theme = useAppStore(s => s.theme);

  useEffect(() => {
    const raf = requestAnimationFrame(() => draw(canvasRef.current, rows, scrollTop, viewportH));
    return () => cancelAnimationFrame(raf);
    // theme 仅作为重绘触发条件：颜色在绘制时从 CSS 变量读取，随主题切换。
  }, [rows, scrollTop, viewportH, theme]);

  return (
    <canvas ref={canvasRef} className="commit-graph-canvas" role="img" aria-label="提交历史泳道图" />
  );
}
