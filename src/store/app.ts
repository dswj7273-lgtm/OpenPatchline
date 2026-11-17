/**
 * 全局应用状态（zustand）：组合各业务 Slice 并导出单例 `useAppStore` 与测试工厂 `createAppStore`。
 */

import { create } from "zustand";
import { createDiffSlice } from "./diffSlice";
import { createLogSlice } from "./logSlice";
import { createRepoSlice } from "./repoSlice";
import { createSettingsSlice } from "./settingsSlice";
import type { ActiveView, AppState, GitBusy, Theme, ThemePreference } from "./types";
import { createUiSlice } from "./uiSlice";
import { createWorkspaceSlice } from "./workspaceSlice";

export type { ActiveView, AppState, GitBusy, Theme, ThemePreference };

export function createAppStore() {
  return create<AppState>()((...a) => ({
    ...createRepoSlice(...a),
    ...createLogSlice(...a),
    ...createDiffSlice(...a),
    ...createWorkspaceSlice(...a),
    ...createSettingsSlice(...a),
    ...createUiSlice(...a),
  }));
}

export const useAppStore = createAppStore();
