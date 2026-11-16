/**
 * Diff 视图导航与单文件 Diff 加载 Slice。
 */

import * as api from "../api/client";
import { reportError, type AppSlice, type DiffSlice } from "./types";

export const createDiffSlice: AppSlice<DiffSlice> = (set, get) => ({
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
    set({ selectedDiffFileIndex: index, diffLoading: true, error: null });
    try {
      const diff = await api.getFileDiff(repo.id, diffScope, file.path);
      if (get().selectedDiffFileIndex !== index) return;
      set({ currentFileDiff: diff });
    } catch (e) {
      set({ error: reportError("showDiffFile", e) });
    } finally {
      set({ diffLoading: false });
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
    set({
      activeView: "log",
      diffScope: null,
      diffFiles: [],
      selectedDiffFileIndex: 0,
      currentFileDiff: null,
    });
  },
});
