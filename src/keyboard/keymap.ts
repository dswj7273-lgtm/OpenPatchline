/**
 * 快捷键注册表（v0.6 / 6.3）：应用全部键位绑定的唯一事实来源。
 *
 * - 组件层不各自硬编码按键判断，统一引用此表的 `matchesKeybinding` 匹配；
 * - 设置页与文档从该表渲染快捷键速查；
 * - 原生菜单（macOS 菜单栏）与前端处理器使用同一组 id。
 *
 * 注意：作用域。全局键（⌘O / ⌘K / ⌘F / ⌘R / ⌘, / ⌘⇧T）在 App 层处理；
 * Diff 视图键（⌘D / [ ] / ⌥↑↓ / ⌘[ ]）在 DiffView（仅挂载于 diff 视图）处理；
 * ⌘Enter 提交在提交信息输入框内处理（CommitComposer）。
 */

export interface KeybindingSpec {
  /** 稳定 id（与原生菜单事件 id 对齐）。 */
  id: string;
  /** 展示名。 */
  label: string;
  /** 展示分组。 */
  group: string;
  /** 主键（e.key 小写；修饰键场景为字符，如 "k"、","、"arrowup"、"enter"）。 */
  key: string;
  /** 是否需要 ⌘/Ctrl。 */
  cmd?: boolean;
  /** 是否需要 Shift。 */
  shift?: boolean;
  /** 是否需要 ⌥/Alt。 */
  alt?: boolean;
  /** 仅文档展示用：说明该键位的生效范围。 */
  scope?: string;
}

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** 全部键位绑定（顺序即速查表顺序）。 */
export const KEYBINDINGS: readonly KeybindingSpec[] = [
  { id: "open-repo", label: "打开仓库", group: "通用", key: "o", cmd: true },
  { id: "command-palette", label: "命令面板", group: "通用", key: "k", cmd: true },
  {
    id: "search",
    label: "搜索提交（聚焦搜索框）",
    group: "通用",
    key: "f",
    cmd: true,
    scope: "提交列表",
  },
  { id: "refresh", label: "刷新仓库状态", group: "通用", key: "r", cmd: true },
  { id: "open-settings", label: "打开设置", group: "通用", key: ",", cmd: true },
  {
    id: "toggle-theme",
    label: "切换深 / 浅主题",
    group: "通用",
    key: "t",
    cmd: true,
    shift: true,
  },
  {
    id: "diff-mode",
    label: "切换分栏 / 统一",
    group: "Diff 视图",
    key: "d",
    cmd: true,
    scope: "Diff 视图",
  },
  { id: "prev-change", label: "上一处变更", group: "Diff 视图", key: "[", scope: "Diff 视图" },
  { id: "next-change", label: "下一处变更", group: "Diff 视图", key: "]", scope: "Diff 视图" },
  {
    id: "prev-change-alt",
    label: "上一处变更（备用）",
    group: "Diff 视图",
    key: "arrowup",
    alt: true,
    scope: "Diff 视图",
  },
  {
    id: "next-change-alt",
    label: "下一处变更（备用）",
    group: "Diff 视图",
    key: "arrowdown",
    alt: true,
    scope: "Diff 视图",
  },
  {
    id: "prev-file",
    label: "上一个文件",
    group: "Diff 视图",
    key: "[",
    cmd: true,
    scope: "Diff 视图",
  },
  {
    id: "next-file",
    label: "下一个文件",
    group: "Diff 视图",
    key: "]",
    cmd: true,
    scope: "Diff 视图",
  },
  {
    id: "commit",
    label: "提交（在提交信息框内）",
    group: "暂存与提交",
    key: "enter",
    cmd: true,
    scope: "提交信息输入框",
  },
  { id: "back", label: "返回 / 关闭当前视图", group: "通用", key: "escape" },
] as const;

const BY_ID = new Map(KEYBINDINGS.map((b) => [b.id, b]));

/** 按 id 查找键位绑定。 */
export function keybinding(id: string): KeybindingSpec | undefined {
  return BY_ID.get(id);
}

/** 按 id 判断键盘事件是否命中（id 不存在时恒为 false）。 */
export function matchesKeyId(e: KeyboardEvent, id: string): boolean {
  const b = BY_ID.get(id);
  return b !== undefined && matchesKeybinding(e, b);
}

/** 判断键盘事件是否命中键位绑定（大小写不敏感；⌘/Ctrl 等价）。 */
export function matchesKeybinding(e: KeyboardEvent, b: KeybindingSpec): boolean {
  const cmd = e.metaKey || e.ctrlKey;
  if ((b.cmd ?? false) !== cmd) return false;
  if ((b.shift ?? false) !== e.shiftKey) return false;
  if ((b.alt ?? false) !== e.altKey) return false;
  if (e.key === undefined) return false;
  const key = e.key.toLowerCase();
  // 无修饰键场景下 Shift 会改变 e.key（如 "[" → "{"），按 code 兜底比较字母数字键。
  if (!b.cmd && !b.alt && e.shiftKey && b.key.length === 1 && key !== b.key) {
    return false;
  }
  return key === b.key;
}

/** 格式化展示文案（⌘K / Ctrl+K 风格）。 */
export function formatKeybinding(b: KeybindingSpec): string {
  const parts: string[] = [];
  if (b.cmd) parts.push(IS_MAC ? "⌘" : "Ctrl+");
  if (b.alt) parts.push(IS_MAC ? "⌥" : "Alt+");
  if (b.shift) parts.push(IS_MAC ? "⇧" : "Shift+");
  const keyName =
    b.key === "arrowup"
      ? "↑"
      : b.key === "arrowdown"
        ? "↓"
        : b.key === "enter"
          ? "Enter"
          : b.key === "escape"
            ? "Esc"
            : b.key;
  parts.push(IS_MAC ? (keyName.length === 1 ? keyName.toUpperCase() : keyName) : keyName);
  return parts.join(IS_MAC ? "" : "");
}
