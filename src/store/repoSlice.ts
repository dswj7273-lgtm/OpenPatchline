/**
 * 仓库会话、最近仓库、主题与全局错误/提示 Slice。
 */

import * as api from "../api/client";
import { loadCommitHistory } from "../utils/commitHelpers";
import {
  persistTheme,
  readInitialTheme,
  reportError,
  type AppSlice,
  type RepoSlice,
} from "./types";

export const createRepoSlice: AppSlice<RepoSlice> = (set, get) => ({
  repo: null,
  recentRepos: [],
  repoCandidates: null,
  theme: readInitialTheme(),
  error: null,
  notice: null,

  openRepo: async (path) => {
    set({ graphLoading: true, error: null, notice: null, repoCandidates: null });
    try {
      const outcome = await api.openRepository(path ?? "");
      if (outcome.kind === "cancelled") {
        return;
      }
      if (outcome.kind === "notARepo") {
        set({ repoCandidates: { path: outcome.path, candidates: outcome.candidates } });
        return;
      }
      const repo = outcome.repo;
      set({
        repo,
        graphRows: [],
        nextCursor: null,
        hasMore: false,
        selectedCommitId: null,
        commitFiles: [],
        commitSignature: null,
        compareRange: null,
        rangeFiles: [],
        activeView: "log",
        diffScope: null,
        diffFiles: [],
        selectedDiffFileIndex: 0,
        currentFileDiff: null,
        diffLoading: false,
        conflictPath: null,
        conflictDetail: null,
        conflictLoading: false,
        blameResult: null,
        blameLoading: false,
        blameHistory: [],
        blameReturnView: "log",
        branches: [],
        stashes: [],
        commitMetadata: null,
        commitHistory: loadCommitHistory(repo.id),
        gitBusy: null,
        pendingRepoRefresh: null,
        remoteProgress: null,
      });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      await get().loadStashes();
      void get().loadCommitMetadata();
      void get().loadRecentRepos();
    } catch (e) {
      set({ error: reportError("openRepo", e) });
      if (path) void get().loadRecentRepos();
    } finally {
      set({ graphLoading: false });
    }
  },

  refreshRepoInfo: async () => {
    const { repo } = get();
    if (!repo) return;
    const repoId = repo.id;
    try {
      const info = await api.getRepoInfo(repoId);
      if (get().repo?.id === repoId) {
        set({ repo: info });
      }
    } catch {
      /* 忽略刷新异常，由主操作捕获 */
    }
  },

  loadRecentRepos: async () => {
    try {
      const recentRepos = await api.getRecentRepositories();
      set({ recentRepos });
    } catch {
      /* 忽略持久化读取异常 */
    }
  },

  removeRecentRepo: async (path) => {
    try {
      const recentRepos = await api.removeRecentRepository(path);
      set({ recentRepos });
    } catch (e) {
      set({ error: reportError("removeRecentRepo", e) });
    }
  },

  dismissRepoCandidates: () => set({ repoCandidates: null }),
  dismissNotice: () => set({ notice: null }),
  clearError: () => set({ error: null }),

  setTheme: (t) => {
    persistTheme(t);
    set({ theme: t });
  },
});
