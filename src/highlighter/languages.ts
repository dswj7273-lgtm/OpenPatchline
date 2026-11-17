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
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { xml } from "@codemirror/lang-xml";
import { StreamLanguage, type LanguageSupport } from "@codemirror/language";
import { kotlin } from "@codemirror/legacy-modes/mode/clike";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { sql } from "@codemirror/legacy-modes/mode/sql";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

/** JS 家族四种变体（js / jsx / ts / tsx）。 */
const jsLang = javascript();
const jsxLang = javascript({ jsx: true });
const tsLang = javascript({ typescript: true });
const tsxLang = javascript({ typescript: true, jsx: true });

/** v0.7 / 7.8 新增：legacy StreamLanguage（yaml / shell / sql / swift / ruby / kotlin）。 */
const yamlLang = StreamLanguage.define(yaml);
const shellLang = StreamLanguage.define(shell);
const sqlLang = StreamLanguage.define(sql({}));
const swiftLang = StreamLanguage.define(swift);
const rubyLang = StreamLanguage.define(ruby);
const kotlinLang = StreamLanguage.define(kotlin);

/** 扩展名（小写、不含点）→ 语言支持。 */
const EXTENSION_LANGUAGES: ReadonlyMap<string, LanguageSupport | StreamLanguage<unknown>> = new Map<
  string,
  LanguageSupport | StreamLanguage<unknown>
>([
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
  // —— v0.7 / 7.8 ——
  ["yml", yamlLang],
  ["yaml", yamlLang],
  ["sh", shellLang],
  ["bash", shellLang],
  ["zsh", shellLang],
  ["sql", sqlLang],
  ["swift", swiftLang],
  ["rb", rubyLang],
  ["php", php()],
  ["kt", kotlinLang],
  ["kts", kotlinLang],
]);

/** 按扩展名查语言支持；未知扩展返回 null（纯文本）。 */
export function languageForExtension(
  ext: string,
): LanguageSupport | StreamLanguage<unknown> | null {
  return EXTENSION_LANGUAGES.get(ext) ?? null;
}

export { extensionOf } from "./extensions";
