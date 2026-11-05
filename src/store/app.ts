/**
 * 全局应用状态（zustand）。
 *
 * 只依赖 api client 与 types；组件层通过 useAppStore 读写。
 * 所有异步动作自行管理 loading 标志，并把错误写入 `error` 状态。
 */

import { create } from "zustand";
import * as api from "../api/client";
import type {
  ChangedFile,
  ChildRepo,
  CommitGraphRow,
  DiffScope,
  FileDiffResult,
  FileStatus,
  LogFilter,
  RepoInfo,
} from "../types";

/** 主区域视图。 */
export type ActiveView = "log" | "diff";

/** 主题。 */
export type Theme = "dark" | "light";

/** 提交图每页条数（docs/03 §7：分页加载）。 */
const GRAPH_PAGE_SIZE = 100;

/** 空的日志过滤器。 */
const EMPTY_LOG_FILTER: LogFilter = {
  branch: null,
  author: null,
  query: null,
  since: null,
  until: null,
};

/** 把 invoke 抛出的未知错误规整为可展示的字符串。 */
function toErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

export interface AppState {
  // ---- 状态 ----
  repo: RepoInfo | null;
  graphRows: CommitGraphRow[];
  nextCursor: string | null;
  hasMore: boolean;
  graphLoading: boolean;
  logFilter: LogFilter;
  selectedCommitId: string | null;
  commitFiles: ChangedFile[];
  activeView: ActiveView;
  diffScope: DiffScope | null;
  diffFiles: ChangedFile[];
  selectedDiffFileIndex: number;
  currentFileDiff: FileDiffResult | null;
  diffLoading: boolean;
  fileStatus: FileStatus[];
  theme: Theme;
  error: string | null;
  /** 所选目录不是仓库时的候选子仓库（App 渲染选择弹层）。 */
  repoCandidates: { path: string; candidates: ChildRepo[] } | null;

  // ---- 动作 ----
  /** 打开仓库（path 为目录选择框起始建议，缺省传空字符串）。 */
  openRepo: (path?: string) => Promise<void>;
  /** 关闭「不是仓库」候选弹层。 */
  dismissRepoCandidates: () => void;
  /** 追加加载下一页提交。 */
  loadMoreCommits: () => Promise<void>;
  /** 用当前 logFilter 从头重建提交图。 */
  reloadGraph: () => Promise<void>;
  /** 选中提交（null 取消选中），加载其文件列表，停留在 log 视图。 */
  selectCommit: (id: string | null) => Promise<void>;
  /** 进入 diff 视图并打开 files[index]。 */
  openFileDiff: (scope: DiffScope, files: ChangedFile[], index: number) => Promise<void>;
  /** 切换到 diffFiles[index] 并加载其内容。 */
  showDiffFile: (index: number) => Promise<void>;
  nextDiffFile: () => Promise<void>;
  prevDiffFile: () => Promise<void>;
  /** 刷新工作区文件状态。 */
  loadFileStatus: () => Promise<void>;
  stageFile: (path: string) => Promise<void>;
  /** 仅暂存指定文件；用于过滤视图中的安全目录批量操作。 */
  stageFiles: (paths: string[]) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  /** 提交暂存区并刷新状态与提交图。 */
  createCommit: (message: string) => Promise<void>;
  /** 关闭 diff 视图，返回 log。 */
  goBackToLog: () => void;
  setTheme: (t: Theme) => void;
  /** 更新过滤器并重建提交图。 */
  setLogFilter: (f: LogFilter) => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  repo: null,
  graphRows: [],
  nextCursor: null,
  hasMore: false,
  graphLoading: false,
  logFilter: EMPTY_LOG_FILTER,
  selectedCommitId: null,
  commitFiles: [],
  activeView: "log",
  diffScope: null,
  diffFiles: [],
  selectedDiffFileIndex: 0,
  currentFileDiff: null,
  diffLoading: false,
  fileStatus: [],
  theme: "dark",
  error: null,
  repoCandidates: null,

  openRepo: async (path) => {
    set({ graphLoading: true, error: null, repoCandidates: null });
    try {
      const outcome = await api.openRepository(path ?? "");
      if (outcome.kind === "cancelled") {
        // 用户在目录选择框中取消：保持当前状态不变。
        return;
      }
      if (outcome.kind === "notARepo") {
        // 所选目录不是仓库：交给 App 的候选弹层（列出子仓库供选择）。
        set({ repoCandidates: { path: outcome.path, candidates: outcome.candidates } });
        return;
      }
      const repo = outcome.repo;
      // 重置会话状态，再加载首页数据。
      set({
        repo,
        graphRows: [],
        nextCursor: null,
        hasMore: false,
        selectedCommitId: null,
        commitFiles: [],
        activeView: "log",
        diffScope: null,
        diffFiles: [],
        selectedDiffFileIndex: 0,
        currentFileDiff: null,
        diffLoading: false,
      });
      await get().reloadGraph();
      await get().loadFileStatus();
    } catch (e) {
      set({ error: toErrorMessage(e) });
    } finally {
      set({ graphLoading: false });
    }
  },

  dismissRepoCandidates: () => set({ repoCandidates: null }),

  loadMoreCommits: async () => {
    const { repo, graphRows, nextCursor, hasMore, logFilter, graphLoading } = get();
    if (!repo) {
      set({ error: "No repository open" });
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
      set({ error: toErrorMessage(e) });
    } finally {
      set({ graphLoading: false });
    }
  },

  reloadGraph: async () => {
    const { repo, logFilter } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    set({ graphLoading: true, error: null });
    try {
      const page = await api.getCommitGraph(repo.id, null, GRAPH_PAGE_SIZE, logFilter);
      set({ graphRows: page.rows, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (e) {
      set({ error: toErrorMessage(e) });
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
      set({ error: "No repository open" });
      return;
    }
    set({ selectedCommitId: id, error: null });
    try {
      const files = await api.getCommitFiles(repo.id, id);
      // 期间选中项被再次改变时丢弃过期结果。
      if (get().selectedCommitId !== id) return;
      set({ commitFiles: files });
    } catch (e) {
      set({ error: toErrorMessage(e) });
    }
  },

  openFileDiff: async (scope, files, index) => {
    const file = files[index];
    if (!file) {
      set({ error: "Invalid file index" });
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
      set({ error: "No repository open" });
      return;
    }
    if (!diffScope) {
      set({ error: "No diff scope selected" });
      return;
    }
    const file = diffFiles[index];
    if (!file) {
      set({ error: "Invalid file index" });
      return;
    }
    set({ selectedDiffFileIndex: index, diffLoading: true, error: null });
    try {
      const diff = await api.getFileDiff(repo.id, diffScope, file.path);
      // 期间切换到了其他文件时丢弃过期结果。
      if (get().selectedDiffFileIndex !== index) return;
      set({ currentFileDiff: diff });
    } catch (e) {
      set({ error: toErrorMessage(e) });
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

  loadFileStatus: async () => {
    const { repo } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    try {
      const status = await api.getFileStatus(repo.id);
      set({ fileStatus: status });
    } catch (e) {
      set({ error: toErrorMessage(e) });
    }
  },

  stageFile: async (path) => {
    const { repo } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    try {
      await api.stageFile(repo.id, path);
      await get().loadFileStatus();
    } catch (e) {
      set({ error: toErrorMessage(e) });
    }
  },

  stageFiles: async (paths) => {
    const { repo } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    if (paths.length === 0) return;
    set({ error: null });
    try {
      // 串行写索引，避免批量 IPC 同时操作 .git/index 造成锁竞争。
      for (const path of paths) await api.stageFile(repo.id, path);
    } catch (e) {
      set({ error: toErrorMessage(e) });
    } finally {
      // 即使中途失败，也刷新已经成功暂存的部分。
      await get().loadFileStatus();
    }
  },

  unstageFile: async (path) => {
    const { repo } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    try {
      await api.unstageFile(repo.id, path);
      await get().loadFileStatus();
    } catch (e) {
      set({ error: toErrorMessage(e) });
    }
  },

  createCommit: async (message) => {
    const { repo } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    try {
      await api.createCommit(repo.id, message);
      await get().loadFileStatus();
      await get().reloadGraph();
    } catch (e) {
      set({ error: toErrorMessage(e) });
    }
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

  setTheme: (t) => set({ theme: t }),

  setLogFilter: (f) => {
    set({ logFilter: f });
    void get().reloadGraph();
  },
}));
