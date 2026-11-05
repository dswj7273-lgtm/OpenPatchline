/**
 * 文件扩展名 → CodeMirror 6 语言支持映射 — docs/05 §10（Phase 5）。
 *
 * 语言对象在模块加载时创建一次并复用（LanguageSupport 自身不持有
 * 每状态数据，可安全嵌入多个 EditorState）。未覆盖的扩展名返回
 * null，调用方按纯文本处理。
 */

import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { xml } from "@codemirror/lang-xml";
import type { LanguageSupport } from "@codemirror/language";

/** JS 家族四种变体（js / jsx / ts / tsx）。 */
const jsLang = javascript();
const jsxLang = javascript({ jsx: true });
const tsLang = javascript({ typescript: true });
const tsxLang = javascript({ typescript: true, jsx: true });

/** 扩展名（小写、不含点）→ 语言支持。 */
const EXTENSION_LANGUAGES: ReadonlyMap<string, LanguageSupport> = new Map([
  ["js", jsLang],
  ["mjs", jsLang],
  ["cjs", jsLang],
  ["jsx", jsxLang],
  ["ts", tsLang],
  ["tsx", tsxLang],
  ["py", python()],
  ["rs", rust()],
  ["java", java()],
  ["json", json()],
  ["html", html()],
  ["vue", html()],
  ["svelte", html()],
  ["css", css()],
  ["scss", css()], // scss 近似按 css 高亮
  ["xml", xml()],
  ["c", cpp()],
  ["h", cpp()],
  ["cpp", cpp()],
  ["hpp", cpp()],
  ["cc", cpp()],
  ["go", go()],
  ["md", markdown()],
  ["markdown", markdown()],
]);

/** 按扩展名查语言支持；未知扩展返回 null（纯文本）。 */
export function languageForExtension(ext: string): LanguageSupport | null {
  return EXTENSION_LANGUAGES.get(ext) ?? null;
}

/** 取文件路径的小写扩展名（不含点）；无扩展名返回空字符串。 */
export function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx <= 0 || idx === path.length - 1) return "";
  return path.slice(idx + 1).toLowerCase();
}
