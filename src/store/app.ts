/**
 * 全局应用状态（zustand）：组合各业务 Slice 并导出单例 `useAppStore` 与测试工厂 `createAppStore`。
 */

import { create } from "zustand";
import { createDiffSlice } from "./diffSlice";
import { createLogSlice } from "./logSlice";
import { createRepoSlice } from "./repoSlice";
import type { ActiveView, AppState, GitBusy, Theme } from "./types";
import { createWorkspaceSlice } from "./workspaceSlice";

export type { ActiveView, AppState, GitBusy, Theme };

export function createAppStore() {
  return create<AppState>()((...a) => ({
    ...createRepoSlice(...a),
    ...createLogSlice(...a),
    ...createDiffSlice(...a),
    ...createWorkspaceSlice(...a),
  }));
}

export const useAppStore = createAppStore();
