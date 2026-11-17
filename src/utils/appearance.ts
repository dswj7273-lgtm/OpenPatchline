/**
 * 外观相关纯函数：主题解析、代码行高换算与文档级 CSS 变量应用。
 *
 * 行高与字号联动（docs/06 §6）：代码行虚拟滚动依赖 JS 与 CSS 使用同一
 * 行高，因此字号设置换算出的行高同时写入 `--code-row-h`（CSS）与
 * store 的 `codeRowHeight`（JS 定位），二者由同一函数派生保证一致。
 */

import type { AppSettings, Theme, ThemePreference } from "../types";

/** 基准字号（px）：默认设置下的代码字号。 */
export const CODE_FONT_BASE = 13;
/** 基准行高（px）：默认字号对应的代码行高。 */
export const CODE_ROW_BASE = 20;

/** 由代码字号换算虚拟滚动行高（px），四舍五入为整数像素。 */
export function rowHeightForFontSize(fontSize: number): number {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : CODE_FONT_BASE;
  return Math.round((size * CODE_ROW_BASE) / CODE_FONT_BASE);
}

/** 读取系统深色模式偏好（matchMedia 不可用时默认深色）。 */
export function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: light)").matches !== true;
}

/** 把主题偏好解析为实际生效主题。 */
export function resolveTheme(pref: ThemePreference): Theme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

/** 去除字体名中可能破坏 CSS 值的引号字符。 */
function safeFontFamily(family: string): string {
  return family.replace(/["'\\]/g, "").trim();
}

/**
 * 把设置应用到文档级 CSS 变量与 `data-theme`：
 * - `--code-size` / `--code-row-h`：代码字号与行高（diff / blame / 冲突编辑器共用）；
 * - `--code-tab-size`：Tab 宽度；
 * - `--font-code`：自定义代码字体（未配置时清除内联覆盖，回退样式表默认栈）；
 * - `data-theme`：实际生效主题（深/浅令牌切换）。
 */
export function applySettingsToDocument(settings: AppSettings, resolvedTheme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.style.setProperty("--code-size", `${settings.codeFontSize}px`);
  root.style.setProperty("--code-row-h", `${rowHeightForFontSize(settings.codeFontSize)}px`);
  root.style.setProperty("--code-tab-size", String(settings.tabWidth));
  const family = safeFontFamily(settings.codeFontFamily);
  if (family) {
    root.style.setProperty("--font-code", `"${family}", ui-monospace, monospace`);
  } else {
    root.style.removeProperty("--font-code");
  }
}
