/**
 * diff 单元格：行号槽 + 语法高亮内容 + 字符级差异高亮 — docs/06 §4。
 *
 * 渲染策略：把一行内容按（token 类 × 是否处于字符级差异区间）切成
 * 连续片段，相邻同属性的字符合并成一个 <span>，避免逐字符建节点。
 * \t 在切片时展开为 4 个空格（token / char_ranges 偏移仍按原始
 * 字符串计算，展开只影响展示宽度）。
 */

import { memo } from "react";
import type { TokenSpan } from "../../highlighter/tokenizer";
import type { CharRange, RowCell } from "../../types";

/** Tab 展示宽度（空格数）。 */
const TAB_WIDTH = 4;

export interface CodeCellProps {
  /** 单元格数据；null 表示 spacer 占位格。 */
  cell: RowCell | null;
  side: "old" | "new";
  /** 该行（cell 所在侧）的 token，行内偏移。 */
  tokens: TokenSpan[];
}

export interface CodeContentProps {
  content: string;
  tokens: TokenSpan[];
  charRanges: CharRange[];
  side: "old" | "new";
}

/** 渲染片段：token 类 × 字符级差异类。 */
interface Segment {
  text: string;
  tokenClass: string;
  charClass: string;
}

/**
 * char_ranges 按字符（Unicode 标量）计（Rust 侧契约），这里转换成
 * UTF-16 偏移；不含代理对时两种偏移一致，直接原样返回。
 */
function toUtf16Ranges(content: string, ranges: CharRange[]): CharRange[] {
  if (!/[\uD800-\uDBFF]/.test(content)) return ranges;
  const offsetOf: number[] = []; // 标量下标 → UTF-16 偏移
  let u16 = 0;
  for (const ch of Array.from(content)) {
    offsetOf.push(u16);
    u16 += ch.length;
  }
  offsetOf.push(u16);
  return ranges.map((r) => ({
    start: offsetOf[r.start] ?? 0,
    end: offsetOf[r.end] ?? u16,
  }));
}

/** 把一行内容切成连续片段；\t 展开为空格。 */
function buildSegments(
  content: string,
  tokens: TokenSpan[],
  ranges: CharRange[],
  charClass: string,
): Segment[] {
  const segments: Segment[] = [];
  let ti = 0; // token 指针
  let ri = 0; // char range 指针
  let cur: Segment | null = null;
  for (let i = 0; i < content.length; i++) {
    while (ti < tokens.length && tokens[ti].end <= i) ti++;
    const tokenClass =
      ti < tokens.length && tokens[ti].start <= i ? tokens[ti].className : "";
    while (ri < ranges.length && ranges[ri].end <= i) ri++;
    const inDiff = ri < ranges.length && ranges[ri].start <= i;
    const text = content[i] === "\t" ? " ".repeat(TAB_WIDTH) : content[i];
    if (cur && cur.tokenClass === tokenClass && cur.charClass === (inDiff ? charClass : "")) {
      cur.text += text;
    } else {
      cur = { text, tokenClass, charClass: inDiff ? charClass : "" };
      segments.push(cur);
    }
  }
  return segments;
}

function classOf(s: Segment): string | undefined {
  const cls = s.charClass ? `${s.tokenClass} ${s.charClass}` : s.tokenClass;
  return cls === "" ? undefined : cls;
}

/** 只渲染高亮内容（统一视图复用）。 */
export function CodeContent({ content, tokens, charRanges, side }: CodeContentProps) {
  const charClass = side === "new" ? "char-add" : "char-remove";
  const segments = buildSegments(content, tokens, toUtf16Ranges(content, charRanges), charClass);
  return (
    <>
      {segments.map((s, i) => (
        <span key={i} className={classOf(s)}>
          {s.text}
        </span>
      ))}
    </>
  );
}

function CodeCellImpl({ cell, side, tokens }: CodeCellProps) {
  if (!cell) {
    // spacer 占位格：无行号、无内容，带斜纹背景。
    return (
      <div className={`diff-cell diff-cell--spacer diff-cell--${side}`}>
        <span className="diff-cell__gutter" />
        <code className="diff-cell__content" />
      </div>
    );
  }
  const kindClass = cell.kind === "context" ? "" : ` diff-cell--${cell.kind}`;
  return (
    <div className={`diff-cell diff-cell--${side}${kindClass}`}>
      <span className="diff-cell__gutter">{cell.lineno ?? ""}</span>
      <code className="diff-cell__content">
        <CodeContent
          content={cell.content}
          tokens={tokens}
          charRanges={cell.charRanges}
          side={side}
        />
      </code>
    </div>
  );
}

/** memo：滚动时行容器重排，单元格 props 不变即可跳过重渲染。 */
const CodeCell = memo(CodeCellImpl);
export default CodeCell;
