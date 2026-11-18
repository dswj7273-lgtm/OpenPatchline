/**
 * 全局浮层 UI Slice：设置弹窗 / 命令面板的开关状态。
 *
 * 与业务 Slice 分离，避免把一次性 UI 状态混入仓库 / 日志数据。
 */

import type { AppSlice, UiSlice } from "./types";

export const createUiSlice: AppSlice<UiSlice> = (set, get) => ({
  settingsOpen: false,
  commandPaletteOpen: false,
  rebaseModalOpen: false,
  onboardingOpen: false,
  openSettings: () => set({ settingsOpen: true, commandPaletteOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  openCommandPalette: () => set({ commandPaletteOpen: true, settingsOpen: false }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  openRebaseModal: () => set({ rebaseModalOpen: true, commandPaletteOpen: false }),
  closeRebaseModal: () => set({ rebaseModalOpen: false }),
  closeOnboarding: () => set({ onboardingOpen: false }),
  // 启动引导（v1.0 / 10.4）：从未打开过仓库且未跳过时自动弹出。
  maybeShowOnboarding: () => {
    const { recentRepos, settings } = get();
    if (recentRepos.length === 0 && !settings.onboardingDismissed) {
      set({ onboardingOpen: true });
    }
  },
});
