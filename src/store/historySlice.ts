/**
 * 文件历史 Slice（v0.7 / 7.1）：单文件提交历史视图状态。
 *
 * `--follow` 数据来自后端；选中条目复用 DiffView（commit scope）展示，
 * 通过 diffReturnView = "history" 让 Esc 从 Diff 返回历史列表而非日志。
 */

import * as api from "../api/client";
import { reportError, type AppSlice, type HistorySlice } from "./types";

export const createHistorySlice: AppSlice<HistorySlice> = (set, get) => {
  let historyReqSeq = 0;

  return {
    historyPath: null,
    historyEntries: [],
    historyLoading: false,

    openFileHistory: async (path) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      const repoId = repo.id;
      const seq = ++historyReqSeq;
      set({
        activeView: "history",
        historyPath: path,
        historyLoading: true,
        error: null,
        // 切换目标文件时清空旧列表，避免闪烁串数据。
        ...(get().historyPath !== path ? { historyEntries: [] } : {}),
      });
      try {
        const entries = await api.getFileHistory(repoId, path);
        if (get().repo?.id !== repoId || seq !== historyReqSeq) return;
        if (get().historyPath !== path) return;
        set({ historyEntries: entries });
      } catch (e) {
        if (get().repo?.id === repoId && seq === historyReqSeq) {
          set({ error: reportError("openFileHistory", e) });
        }
      } finally {
        if (seq === historyReqSeq) {
          set({ historyLoading: false });
        }
      }
    },

    closeFileHistory: () => {
      historyReqSeq++;
      set({
        activeView: "log",
        historyPath: null,
        historyEntries: [],
        historyLoading: false,
      });
    },
  };
};
