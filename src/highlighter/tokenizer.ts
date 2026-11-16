/**
 * 语法分词器 — docs/05 §10（Phase 5）。
 *
 * 用 CM6 语言包的 Lezer 语法树做同步分词，把高亮 tag 归并为一小组
 * tok-* CSS 类（见 tokens.css），并按行切分：offset 均为行内
 * UTF-16 code unit 偏移（与 JS 字符串下标一致）。
 *
 * 大文件保护：超过 MAX_LINES 行只分词前 MAX_LINES 行，其余行返回
 * 空数组（console.warn 只提示一次），保证同步分词不长时间阻塞 UI。
 */

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree, tags, type Highlighter, type Tag } from "@lezer/highlight";
import { languageForExtension } from "./languages";

/** 行内 token：start/end 为行内字符偏移（含 start，不含 end）。 */
export interface TokenSpan {
  start: number;
  end: number;
  /** tok-* CSS 类名。 */
  className: string;
}

/** 分词结果（含大文件降级标记）。 */
export interface TokenizeResult {
  tokens: TokenSpan[][];
  /** 是否因行数、字符数或超长压缩行触发降级。 */
  degraded: boolean;
}

/** 分词的最大行数；超出部分不做语法高亮。 */
const MAX_LINES = 5000;
/** 单侧最大字符数；超出则整侧降级为纯文本，防止大文件/压缩包阻塞 Worker。 */
const MAX_CHARS = 400_000;
/** 单行最大字符数；超出视为压缩/机器生成文件，整侧降级为纯文本。 */
const MAX_SINGLE_LINE_CHARS = 4000;

/** 完整解析的时间预算（ms）：给足以覆盖 MAX_LINES 行的解析。 */
const PARSE_BUDGET_MS = 1e9;

/** 超限提示只发一次。 */
let warnedTooManyLines = false;

/**
 * tag → tok-* 类映射表。查表时按 tag.set（自身及父 tag，按特异性
 * 降序）取第一个命中，因此子 tag 自动覆盖父 tag 的默认色。
 */
const TAG_CLASS: ReadonlyMap<Tag, string> = new Map([
  // 注释 / 元信息
  [tags.lineComment, "tok-com"],
  [tags.blockComment, "tok-com"],
  [tags.docComment, "tok-com"],
  [tags.comment, "tok-com"],
  [tags.meta, "tok-com"],
  [tags.processingInstruction, "tok-com"],
  [tags.documentMeta, "tok-com"],
  // 字符串族
  [tags.string, "tok-str"],
  [tags.docString, "tok-str"],
  [tags.character, "tok-str"],
  [tags.attributeValue, "tok-str"],
  [tags.regexp, "tok-str"],
  [tags.escape, "tok-str"],
  [tags.url, "tok-str"],
  [tags.color, "tok-str"],
  // 数字
  [tags.number, "tok-num"],
  // 原子（true / false / null 等）
  [tags.bool, "tok-atom"],
  [tags.null, "tok-atom"],
  [tags.atom, "tok-atom"],
  // 函数名（function 修饰的变量 / 属性）
  [tags.function(tags.variableName), "tok-fn"],
  [tags.function(tags.propertyName), "tok-fn"],
  // 类型族
  [tags.typeName, "tok-type"],
  [tags.tagName, "tok-type"],
  [tags.className, "tok-type"],
  [tags.namespace, "tok-type"],
  [tags.macroName, "tok-type"],
  // 属性 / 标签名
  [tags.propertyName, "tok-prop"],
  [tags.attributeName, "tok-prop"],
  [tags.labelName, "tok-prop"],
  // 变量（name 为兜底）
  [tags.variableName, "tok-var"],
  [tags.name, "tok-var"],
  // 运算符 / 标点 / 关键字
  [tags.operator, "tok-op"],
  [tags.punctuation, "tok-punct"],
  [tags.keyword, "tok-kw"],
  // Markdown 结构色
  [tags.heading, "tok-kw"],
  [tags.link, "tok-str"],
  [tags.monospace, "tok-str"],
  [tags.contentSeparator, "tok-punct"],
]);

/** 把一组 tag 映射到唯一的 tok-* 类；无命中返回 null（不着色）。 */
const highlighter: Highlighter = {
  style: (tagList) => {
    for (const tag of tagList) {
      for (const t of tag.set) {
        const cls = TAG_CLASS.get(t);
        if (cls) return cls;
      }
    }
    return null;
  },
};

/** 计算各行起点偏移（行内容不含换行符）。 */
function lineStartsOf(s: string): number[] {
  const starts = [0];
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 是否存在超长行（如单行压缩 JS/JSON）。 */
function hasOverlongLine(s: string, starts: number[]): boolean {
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : s.length;
    if (end - starts[i] > MAX_SINGLE_LINE_CHARS) return true;
  }
  return false;
}

/**
 * 对完整文本做语法分词，返回逐行 token 与降级标记。
 *
 * @param content 完整文本（行间以 \n 分隔，无行尾换行亦可）
 * @param langId  文件扩展名（见 languages.ts）；未知扩展按纯文本处理
 */
export function tokenizeDetailed(content: string, langId: string): TokenizeResult {
  const lang = languageForExtension(langId);
  const totalStarts = lineStartsOf(content);
  const totalLines = totalStarts.length;

  if (!lang) {
    // 无语言支持：全部行为空 token（纯文本渲染）。
    return { tokens: Array.from({ length: totalLines }, () => []), degraded: false };
  }

  // 超大文本或包含单行压缩超长行：直接降级为纯文本。
  if (content.length > MAX_CHARS || hasOverlongLine(content, totalStarts)) {
    return { tokens: Array.from({ length: totalLines }, () => []), degraded: true };
  }

  // 超过行数上限时截断到前 MAX_LINES 行（含行尾换行）。
  let doc = content;
  let degraded = false;
  if (totalLines > MAX_LINES) {
    degraded = true;
    doc = content.slice(0, totalStarts[MAX_LINES]);
    if (!warnedTooManyLines) {
      warnedTooManyLines = true;
      console.warn(
        `[openpatchline] 文件超过 ${MAX_LINES} 行，仅对前 ${MAX_LINES} 行做语法高亮`,
      );
    }
  }

  const state = EditorState.create({ doc, extensions: [lang] });
  const tree = ensureSyntaxTree(state, doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);

  // 全文档平坦 token 区间：highlightTree 按位置顺序回调且区间不重叠。
  const flat: Array<{ from: number; to: number; cls: string }> = [];
  highlightTree(tree, highlighter, (from, to, cls) => {
    if (to > from) flat.push({ from, to, cls });
  });

  // 按行切分（token 可能跨行，例如块注释）。
  const starts = lineStartsOf(doc);
  const lines: TokenSpan[][] = Array.from({ length: starts.length }, () => []);
  let li = 0;
  for (const { from, to, cls } of flat) {
    while (li + 1 < starts.length && starts[li + 1] <= from) li++;
    let line = li;
    let pos = from;
    while (pos < to && line < starts.length) {
      const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : doc.length;
      const segEnd = Math.min(to, lineEnd);
      if (segEnd > pos) {
        const base = starts[line];
        lines[line].push({ start: pos - base, end: segEnd - base, className: cls });
      }
      if (segEnd >= to) break;
      line++;
      pos = line < starts.length ? starts[line] : to;
    }
  }

  // 被截断的行补空数组，保证返回长度与原内容行数一致。
  while (lines.length < totalLines) lines.push([]);
  return { tokens: lines, degraded };
}

/** 兼容入口：仅返回逐行 token 数组。 */
export function tokenize(content: string, langId: string): TokenSpan[][] {
  return tokenizeDetailed(content, langId).tokens;
}
