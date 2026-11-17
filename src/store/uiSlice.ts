/**
 * 全局浮层 UI Slice：设置弹窗 / 命令面板的开关状态。
 *
 * 与业务 Slice 分离，避免把一次性 UI 状态混入仓库 / 日志数据。
 */

import type { AppSlice, UiSlice } from "./types";

export const createUiSlice: AppSlice<UiSlice> = (set) => ({
  settingsOpen: false,
  commandPaletteOpen: false,
  openSettings: () => set({ settingsOpen: true, commandPaletteOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  openCommandPalette: () => set({ commandPaletteOpen: true, settingsOpen: false }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
});
