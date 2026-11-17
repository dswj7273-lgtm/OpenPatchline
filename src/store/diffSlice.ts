/**
 * Diff 视图导航、单文件 Diff 加载与 Hunk/行级局部应用 Slice。
 */

import * as api from "../api/client";
import type { DiffPatchAction } from "../types";
import { reportError, type AppSlice, type DiffSlice } from "./types";

const PATCH_ACTION_CLEARED_NOTICE: Record<DiffPatchAction, string> = {
  stage: "已暂存所选变更，当前文件工作区已无剩余修改",
  unstage: "已取消暂存所选变更，当前文件暂存区已清空",
  discard: "已丢弃所选变更，当前文件工作区已恢复",
};

const PATCH_ACTION_NOTICE: Record<DiffPatchAction, string> = {
  stage: "已暂存所选变更",
  unstage: "已取消暂存所选变更",
  discard: "已丢弃所选变更",
};

export const createDiffSlice: AppSlice<DiffSlice> = (set, get) => {
  let diffReqSeq = 0;

  return {
    activeView: "log",
    diffScope: null,
    diffFiles: [],
    selectedDiffFileIndex: 0,
    currentFileDiff: null,
    diffLoading: false,

    openFileDiff: async (scope, files, index) => {
      const file = files[index];
      if (!file) {
        set({ error: "无效的文件索引" });
        return;
      }
      set({
        activeView: "diff",
        diffScope: scope,
        diffFiles: files,
        selectedDiffFileIndex: index,
        error: null,
      });
      await get().showDiffFile(index);
    },

    showDiffFile: async (index) => {
      const { repo, diffScope, diffFiles } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      if (!diffScope) {
        set({ error: "未选择差异比较范围" });
        return;
      }
      const file = diffFiles[index];
      if (!file) {
        set({ error: "无效的文件索引" });
        return;
      }
      const repoId = repo.id;
      const scopeSnapshot = diffScope;
      const seq = ++diffReqSeq;
      set({ selectedDiffFileIndex: index, diffLoading: true, error: null });
      try {
        const diff = await api.getFileDiff(repoId, scopeSnapshot, file.path);
        const latest = get();
        if (
          latest.repo?.id !== repoId ||
          seq !== diffReqSeq ||
          latest.diffScope !== scopeSnapshot ||
          latest.selectedDiffFileIndex !== index ||
          latest.diffFiles[index]?.path !== file.path
        ) {
          return;
        }
        set({ currentFileDiff: diff });
      } catch (e) {
        if (get().repo?.id === repoId && seq === diffReqSeq) {
          set({ error: reportError("showDiffFile", e) });
        }
      } finally {
        if (seq === diffReqSeq) {
          set({ diffLoading: false });
        }
      }
    },

    nextDiffFile: async () => {
      const { diffFiles, selectedDiffFileIndex } = get();
      if (selectedDiffFileIndex + 1 >= diffFiles.length) return;
      await get().showDiffFile(selectedDiffFileIndex + 1);
    },

    prevDiffFile: async () => {
      const { selectedDiffFileIndex } = get();
      if (selectedDiffFileIndex <= 0) return;
      await get().showDiffFile(selectedDiffFileIndex - 1);
    },

    goBackToLog: () => {
      diffReqSeq++;
      set({
        activeView: "log",
        diffScope: null,
        diffFiles: [],
        selectedDiffFileIndex: 0,
        currentFileDiff: null,
        diffLoading: false,
      });
    },

    applyDiffSelection: async (action, selections) => {
      const { repo, diffScope, diffFiles, selectedDiffFileIndex, currentFileDiff, gitBusy } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return false;
      }
      if (!diffScope || (diffScope.kind !== "workdir" && diffScope.kind !== "staged")) {
        set({ error: "当前对比范围不支持局部暂存或丢弃" });
        return false;
      }
      const currentFile = diffFiles[selectedDiffFileIndex];
      if (!currentFile || gitBusy !== null || selections.length === 0) return false;

      const repoId = repo.id;
      set({ gitBusy: "patch", error: null, notice: null });
      try {
        await api.applyDiffSelection(repoId, diffScope, currentFile.path, action, selections);
        if (get().repo?.id !== repoId) return false;

        await get().loadFileStatus();
        const updatedStatus = get().fileStatus;
        const renamedNewPath = currentFileDiff?.newPath;
        const entry =
          updatedStatus.find((f) => f.path === currentFile.path) ??
          (renamedNewPath ? updatedStatus.find((f) => f.path === renamedNewPath) : undefined);

        const stillChanged =
          entry !== undefined &&
          !entry.conflicted &&
          (diffScope.kind === "staged" ? entry.staged !== null : entry.unstaged !== null);

        if (stillChanged && entry) {
          const nextFiles = diffFiles.map((f, idx) =>
            idx === selectedDiffFileIndex ? { ...f, path: entry.path } : f,
          );
          const refreshed = await api.getFileDiff(repoId, diffScope, entry.path);
          if (get().repo?.id === repoId && get().diffScope === diffScope) {
            set({
              diffFiles: nextFiles,
              currentFileDiff: refreshed,
              notice: PATCH_ACTION_NOTICE[action],
            });
          }
          return true;
        }

        const remaining = diffFiles.filter((_, idx) => idx !== selectedDiffFileIndex);
        if (remaining.length > 0) {
          const nextIndex = Math.min(selectedDiffFileIndex, remaining.length - 1);
          set({
            diffFiles: remaining,
            selectedDiffFileIndex: nextIndex,
            notice: PATCH_ACTION_NOTICE[action],
          });
          await get().showDiffFile(nextIndex);
        } else {
          get().goBackToLog();
          set({ notice: PATCH_ACTION_CLEARED_NOTICE[action] });
        }
        return true;
      } catch (e) {
        if (get().repo?.id === repoId) {
          set({ error: reportError("applyDiffSelection", e) });
        }
        return false;
      } finally {
        set({ gitBusy: null });
      }
    },
  };
};
