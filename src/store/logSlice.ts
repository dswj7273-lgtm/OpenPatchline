/**
 * 提交历史图与提交详情 Slice。
 */

import * as api from "../api/client";
import {
  EMPTY_LOG_FILTER,
  GRAPH_PAGE_SIZE,
  reportError,
  type AppSlice,
  type LogSlice,
} from "./types";

export const createLogSlice: AppSlice<LogSlice> = (set, get) => ({
  graphRows: [],
  nextCursor: null,
  hasMore: false,
  graphLoading: false,
  logFilter: EMPTY_LOG_FILTER,
  selectedCommitId: null,
  commitFiles: [],

  loadMoreCommits: async () => {
    const { repo, graphRows, nextCursor, hasMore, logFilter, graphLoading } = get();
    if (!repo) {
      set({ error: "当前未打开仓库" });
      return;
    }
    if (!hasMore || nextCursor === null || graphLoading) return;
    set({ graphLoading: true, error: null });
    try {
      const page = await api.getCommitGraph(repo.id, nextCursor, GRAPH_PAGE_SIZE, logFilter);
      set({
        graphRows: [...graphRows, ...page.rows],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } catch (e) {
      set({ error: reportError("loadMoreCommits", e) });
    } finally {
      set({ graphLoading: false });
    }
  },

  reloadGraph: async () => {
    const { repo, logFilter } = get();
    if (!repo) {
      set({ error: "当前未打开仓库" });
      return;
    }
    set({ graphLoading: true, error: null });
    try {
      const page = await api.getCommitGraph(repo.id, null, GRAPH_PAGE_SIZE, logFilter);
      set({ graphRows: page.rows, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (e) {
      set({ error: reportError("reloadGraph", e) });
    } finally {
      set({ graphLoading: false });
    }
  },

  selectCommit: async (id) => {
    if (id === null) {
      set({ selectedCommitId: null, commitFiles: [] });
      return;
    }
    const { repo } = get();
    if (!repo) {
      set({ error: "当前未打开仓库" });
      return;
    }
    set({ selectedCommitId: id, error: null });
    try {
      const files = await api.getCommitFiles(repo.id, id);
      if (get().selectedCommitId !== id) return;
      set({ commitFiles: files });
    } catch (e) {
      set({ error: reportError("selectCommit", e) });
    }
  },

  setLogFilter: (f) => {
    set({ logFilter: f });
    void get().reloadGraph();
  },
});
