/**
 * 支持语法高亮的文件扩展名集合（纯字符串，零解析器体积，供主线程快速判定）。
 */

export const HIGHLIGHTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rs",
  "java",
  "json",
  "html",
  "vue",
  "svelte",
  "css",
  "scss",
  "xml",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "go",
  "md",
  "markdown",
]);

/** 取文件路径的小写扩展名（不含点）；无扩展名返回空字符串。 */
export function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx <= 0 || idx === path.length - 1) return "";
  return path.slice(idx + 1).toLowerCase();
}
