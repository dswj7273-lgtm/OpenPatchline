/**
 * 全局动作路由（v0.6 / 6.3）：把动作 id（快捷键 / 原生菜单 / 命令面板
 * 共用）映射为 store 调用。返回是否已消费（用于决定是否阻止默认行为）。
 */

import { useAppStore } from "../store/app";

/** 刷新当前仓库全部状态（⌘R / 菜单「刷新」）。 */
export function refreshRepoState(): void {
  const s = useAppStore.getState();
  if (!s.repo) return;
  void s.refreshRepoInfo();
  void s.loadFileStatus();
  void s.reloadGraph();
  void s.loadBranches();
  void s.loadStashes();
}

export function runAppAction(id: string): boolean {
  const s = useAppStore.getState();
  switch (id) {
    case "open-repo":
      void s.openRepo();
      return true;
    case "command-palette":
      if (s.commandPaletteOpen) s.closeCommandPalette();
      else s.openCommandPalette();
      return true;
    case "search":
      // 搜索框属于提交列表视图；其余视图不拦截浏览器默认行为。
      if (s.activeView === "log") {
        s.focusSearch();
        return true;
      }
      return false;
    case "refresh":
      refreshRepoState();
      return true;
    case "open-settings":
      s.openSettings();
      return true;
    case "toggle-theme":
      s.toggleTheme();
      return true;
    default:
      return false;
  }
}
