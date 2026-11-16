/**
 * 全局应用状态（zustand）。
 *
 * 只依赖 api client 与 types；组件层通过 useAppStore 读写。
 * 所有异步动作自行管理 loading 标志，并把错误写入 `error` 状态。
 */

import { create } from "zustand";
import * as api from "../api/client";
import type {
  BranchInfo,
  ChangedFile,
  ChildRepo,
  CommitGraphRow,
  DiffScope,
  FileDiffResult,
  FileStatus,
  LogFilter,
  RepoInfo,
  ResetMode,
  StashEntry,
} from "../types";

/** 主区域视图。 */
export type ActiveView = "log" | "diff";

/** 主题。 */
export type Theme = "dark" | "light";

/** 进行中的 git 操作，用于互斥与按钮态。 */
export type GitBusy =
  | "fetch"
  | "pull"
  | "push"
  | "checkout"
  | "branch"
  | "merge"
  | "tag"
  | "cherryPick"
  | "revert"
  | "reset"
  | "discard"
  | "amend"
  | "stash"
  | null;

/** 提交图每页条数（docs/03 §7：分页加载）。 */
const GRAPH_PAGE_SIZE = 100;

/** 读取本地持久化的主题偏好（不可用时回退深色），并同步到根元素避免首帧闪烁。 */
function readInitialTheme(): Theme {
  let initial: Theme = "dark";
  try {
    const saved = window.localStorage.getItem("openpatchline:theme");
    if (saved === "light" || saved === "dark") initial = saved;
  } catch {
    /* 隐私模式或禁用存储时静默回退 */
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = initial;
  }
  return initial;
}

/** 写入主题偏好。 */
function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem("openpatchline:theme", theme);
  } catch {
    /* 忽略 */
  }
}

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

/** 取 git 输出的最后一行作为通知摘要（"Already up to date." 等）。 */
function lastOutputLine(output: string): string | null {
  const line = output
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .pop();
  return line ?? null;
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
  /** 成功类提示（拉取完成等）；与 error 一样由顶部提示条展示。 */
  notice: string | null;
  /** 所选目录不是仓库时的候选子仓库（App 渲染选择弹层）。 */
  repoCandidates: { path: string; candidates: ChildRepo[] } | null;
  /** 分支列表（本地在前、远程在后）。 */
  branches: BranchInfo[];
  branchesLoading: boolean;
  /** 贮藏栈列表。 */
  stashes: StashEntry[];
  /** 进行中的 git 操作（null = 空闲）；进行中禁用相关按钮。 */
  gitBusy: GitBusy;

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
  /** 仅取消暂存指定文件；用于过滤视图中的安全目录批量操作。 */
  unstageFiles: (paths: string[]) => Promise<void>;
  /** 提交暂存区并刷新状态与提交图。 */
  createCommit: (message: string) => Promise<void>;
  /** 刷新分支列表（含 ahead/behind）。 */
  loadBranches: () => Promise<void>;
  /** 切换分支；成功后刷新仓库信息、提交图与文件状态。 */
  checkoutBranch: (name: string) => Promise<void>;
  /** 从默认远程拉取（fetch，不合并），刷新分支与提交图。 */
  fetchRemote: () => Promise<void>;
  /** 拉取并合并当前分支（pull），成功后全面刷新。 */
  pullRepo: () => Promise<void>;
  /** 推送当前分支（push；无上游时建立跟踪），成功后刷新分支与图。 */
  pushRepo: () => Promise<void>;
  /** 刷新贮藏栈列表。 */
  loadStashes: () => Promise<void>;
  /** 获取全部远程。 */
  fetchAll: () => Promise<void>;
  /** 使用 rebase + autostash 拉取。 */
  pullRebase: () => Promise<void>;
  /** 安全强推（--force-with-lease）。 */
  pushForceWithLease: () => Promise<void>;
  /** 推送全部标签。 */
  pushTags: () => Promise<void>;
  /** 新建分支（可选指定起点与立即切换）。 */
  createBranch: (name: string, startPoint?: string | null, checkout?: boolean) => Promise<boolean>;
  /** 删除本地分支。 */
  deleteBranch: (name: string, force?: boolean) => Promise<void>;
  /** 合并指定分支到当前分支。 */
  mergeBranch: (name: string) => Promise<void>;
  /** 创建标签。 */
  createTag: (name: string, target?: string | null) => Promise<boolean>;
  /** 挑选提交（cherry-pick）。 */
  cherryPickCommit: (commitId: string) => Promise<void>;
  /** 撤销提交（revert）。 */
  revertCommit: (commitId: string) => Promise<void>;
  /** 重置 HEAD。 */
  resetHead: (target: string, mode: ResetMode) => Promise<void>;
  /** 丢弃单文件未暂存/未跟踪更改。 */
  discardFile: (path: string) => Promise<void>;
  /** 丢弃全部未提交更改。 */
  discardAllChanges: () => Promise<void>;
  /** 修正最近一次提交。 */
  amendCommit: (message: string) => Promise<boolean>;
  /** 贮藏当前更改。 */
  stashPush: (message?: string | null) => Promise<boolean>;
  /** 应用或弹出贮藏。 */
  stashApply: (index: number, pop: boolean) => Promise<void>;
  /** 删除贮藏。 */
  stashDrop: (index: number) => Promise<void>;
  /** 关闭成功提示条。 */
  dismissNotice: () => void;
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
  theme: readInitialTheme(),
  error: null,
  notice: null,
  repoCandidates: null,
  branches: [],
  branchesLoading: false,
  stashes: [],
  gitBusy: null,

  openRepo: async (path) => {
    set({ graphLoading: true, error: null, notice: null, repoCandidates: null });
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
        branches: [],
        stashes: [],
        // 防御：上个仓库的远程操作若仍在飞行，新会话不得继承忙碌态。
        gitBusy: null,
      });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      await get().loadStashes();
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

  unstageFiles: async (paths) => {
    const { repo } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    if (paths.length === 0) return;
    set({ error: null });
    try {
      for (const path of paths) await api.unstageFile(repo.id, path);
    } catch (e) {
      set({ error: toErrorMessage(e) });
    } finally {
      await get().loadFileStatus();
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

  loadBranches: async () => {
    const { repo } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    set({ branchesLoading: true });
    try {
      const branches = await api.listBranches(repo.id);
      set({ branches });
    } catch (e) {
      set({ error: toErrorMessage(e) });
    } finally {
      set({ branchesLoading: false });
    }
  },

  checkoutBranch: async (name) => {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    if (gitBusy !== null) return; // 已有 git 操作进行中
    const repoId = repo.id;
    set({ gitBusy: "checkout", error: null, notice: null });
    try {
      const info = await api.checkoutBranch(repoId, name);
      // 操作期间用户打开了其他仓库：丢弃本次结果，不覆盖新会话状态。
      if (get().repo?.id !== repoId) return;
      // 分支过滤指向旧分支时清掉，切换后图跟随新 HEAD。
      const filter = get().logFilter;
      if (filter.branch !== null) {
        set({ logFilter: { ...filter, branch: null } });
      }
      set({
        repo: info,
        selectedCommitId: null,
        commitFiles: [],
      });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      // 依赖刷新全部成功后才提示成功（避免成功通知与失败错误条并存）。
      if (get().error === null) {
        set({ notice: `已切换到 ${info.headBranch ?? name}` });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      // 无条件清 busy：openRepo 不经 gitBusy，切仓后也不应停留忙碌态。
      set({ gitBusy: null });
    }
  },

  fetchRemote: async () => {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "fetch", error: null, notice: null });
    try {
      const result = await api.fetchRepository(repoId, null);
      if (get().repo?.id !== repoId) return;
      // 远程引用更新：刷新分支（ahead/behind）与图上的远程标签。
      await get().loadBranches();
      await get().reloadGraph();
      if (get().error === null) {
        const summary = lastOutputLine(result.output);
        set({
          notice: `已获取 ${result.remote}${summary ? `：${summary}` : ""}`,
        });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  pullRepo: async () => {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "pull", error: null, notice: null });
    try {
      const result = await api.pullRepository(repoId);
      if (get().repo?.id !== repoId) return;
      set({
        repo: result.repo,
        // 拉取可能重写历史（rebase）或新增合并提交，重置选中与详情。
        selectedCommitId: null,
        commitFiles: [],
      });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      if (get().error === null) {
        const summary = lastOutputLine(result.output);
        set({ notice: `拉取完成${summary ? `：${summary}` : ""}` });
      }
    } catch (e) {
      if (get().repo?.id !== repoId) return;
      set({ error: toErrorMessage(e) });
      // 冲突的 pull 虽失败，但远程引用已更新、工作区已写入冲突标记：
      // 仍刷新各视图，把真实状态呈现给用户。
      await get().loadFileStatus();
      await get().reloadGraph();
      await get().loadBranches();
    } finally {
      set({ gitBusy: null });
    }
  },

  pushRepo: async () => {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return;
    }
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "push", error: null, notice: null });
    try {
      const result = await api.pushRepository(repoId);
      if (get().repo?.id !== repoId) return;
      set({ repo: result.repo });
      // 推送更新远程侧：刷新分支（ahead 归零）与图上的远程标签。
      await get().loadBranches();
      await get().reloadGraph();
      if (get().error === null) {
        const summary = lastOutputLine(result.output);
        set({ notice: `推送完成${summary ? `：${summary}` : ""}` });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  loadStashes: async () => {
    const { repo } = get();
    if (!repo) return;
    try {
      const stashes = await api.listStashes(repo.id);
      if (get().repo?.id === repo.id) set({ stashes });
    } catch {
      /* 空仓库或暂不可用时静默忽略 */
    }
  },

  fetchAll: async () => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "fetch", error: null, notice: null });
    try {
      const res = await api.fetchAllRemotes(repoId);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().loadBranches();
      await get().reloadGraph();
      if (get().error === null) {
        const summary = lastOutputLine(res.output);
        set({ notice: `已获取全部远程${summary ? `：${summary}` : ""}` });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  pullRebase: async () => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "pull", error: null, notice: null });
    try {
      const res = await api.pullRebaseRepository(repoId);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo, selectedCommitId: null, commitFiles: [] });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      if (get().error === null) {
        const summary = lastOutputLine(res.output);
        set({ notice: `变基拉取完成${summary ? `：${summary}` : ""}` });
      }
    } catch (e) {
      if (get().repo?.id !== repoId) return;
      set({ error: toErrorMessage(e) });
      await get().loadFileStatus();
      await get().reloadGraph();
      await get().loadBranches();
    } finally {
      set({ gitBusy: null });
    }
  },

  pushForceWithLease: async () => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "push", error: null, notice: null });
    try {
      const res = await api.pushForceWithLeaseRepository(repoId);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().loadBranches();
      await get().reloadGraph();
      if (get().error === null) {
        const summary = lastOutputLine(res.output);
        set({ notice: `安全强推完成${summary ? `：${summary}` : ""}` });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  pushTags: async () => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "push", error: null, notice: null });
    try {
      const res = await api.pushTagsRepository(repoId);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().reloadGraph();
      if (get().error === null) {
        const summary = lastOutputLine(res.output);
        set({ notice: `标签推送完成${summary ? `：${summary}` : ""}` });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  createBranch: async (name, startPoint = null, checkout = true) => {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return false;
    }
    if (gitBusy !== null) return false;
    const repoId = repo.id;
    set({ gitBusy: "branch", error: null, notice: null });
    try {
      const res = await api.createBranch(repoId, name, startPoint ?? null, checkout);
      if (get().repo?.id !== repoId) return false;
      set({ repo: res.repo });
      await get().loadBranches();
      await get().reloadGraph();
      await get().loadFileStatus();
      if (get().error === null) {
        set({ notice: checkout ? `已创建并切换到分支 ${name}` : `已创建分支 ${name}` });
        return true;
      }
      return false;
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
      return false;
    } finally {
      set({ gitBusy: null });
    }
  },

  deleteBranch: async (name, force = false) => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "branch", error: null, notice: null });
    try {
      const res = await api.deleteBranch(repoId, name, force);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().loadBranches();
      await get().reloadGraph();
      if (get().error === null) set({ notice: `已删除分支 ${name}` });
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  mergeBranch: async (name) => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "merge", error: null, notice: null });
    try {
      const res = await api.mergeBranch(repoId, name);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo, selectedCommitId: null, commitFiles: [] });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      if (get().error === null) {
        const summary = lastOutputLine(res.output);
        set({ notice: `已合并 ${name}${summary ? `：${summary}` : ""}` });
      }
    } catch (e) {
      if (get().repo?.id !== repoId) return;
      set({ error: toErrorMessage(e) });
      await get().loadFileStatus();
      await get().reloadGraph();
      await get().loadBranches();
    } finally {
      set({ gitBusy: null });
    }
  },

  createTag: async (name, target = null) => {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return false;
    }
    if (gitBusy !== null) return false;
    const repoId = repo.id;
    set({ gitBusy: "tag", error: null, notice: null });
    try {
      const res = await api.createTag(repoId, name, target ?? null);
      if (get().repo?.id !== repoId) return false;
      set({ repo: res.repo });
      await get().reloadGraph();
      if (get().error === null) {
        set({ notice: `已创建标签 ${name}` });
        return true;
      }
      return false;
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
      return false;
    } finally {
      set({ gitBusy: null });
    }
  },

  cherryPickCommit: async (commitId) => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "cherryPick", error: null, notice: null });
    try {
      const res = await api.cherryPickCommit(repoId, commitId);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      if (get().error === null) {
        set({ notice: `已挑选提交 ${commitId.slice(0, 7)} 到当前分支` });
      }
    } catch (e) {
      if (get().repo?.id !== repoId) return;
      set({ error: toErrorMessage(e) });
      await get().loadFileStatus();
      await get().reloadGraph();
    } finally {
      set({ gitBusy: null });
    }
  },

  revertCommit: async (commitId) => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "revert", error: null, notice: null });
    try {
      const res = await api.revertCommit(repoId, commitId);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      if (get().error === null) {
        set({ notice: `已回滚提交 ${commitId.slice(0, 7)}` });
      }
    } catch (e) {
      if (get().repo?.id !== repoId) return;
      set({ error: toErrorMessage(e) });
      await get().loadFileStatus();
      await get().reloadGraph();
    } finally {
      set({ gitBusy: null });
    }
  },

  resetHead: async (target, mode) => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "reset", error: null, notice: null });
    try {
      const res = await api.resetHead(repoId, target, mode);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo, selectedCommitId: null, commitFiles: [] });
      await get().reloadGraph();
      await get().loadFileStatus();
      await get().loadBranches();
      if (get().error === null) {
        set({ notice: `已重置（--${mode}）到 ${target.length > 10 ? target.slice(0, 7) : target}` });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  discardFile: async (path) => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "discard", error: null, notice: null });
    try {
      await api.discardFile(repoId, path);
      if (get().repo?.id !== repoId) return;
      await get().loadFileStatus();
      if (get().error === null) {
        set({ notice: `已丢弃更改：${path}` });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  discardAllChanges: async () => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "discard", error: null, notice: null });
    try {
      const res = await api.discardAll(repoId);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().loadFileStatus();
      await get().reloadGraph();
      await get().loadBranches();
      if (get().error === null) {
        set({ notice: "已丢弃工作区与暂存区全部未提交更改" });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  amendCommit: async (message) => {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return false;
    }
    if (gitBusy !== null) return false;
    const repoId = repo.id;
    set({ gitBusy: "amend", error: null, notice: null });
    try {
      const res = await api.amendCommit(repoId, message);
      if (get().repo?.id !== repoId) return false;
      set({ repo: res.repo });
      await get().loadFileStatus();
      await get().reloadGraph();
      await get().loadBranches();
      if (get().error === null) {
        set({ notice: "已修正最近一次提交（Amend）" });
        return true;
      }
      return false;
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
      return false;
    } finally {
      set({ gitBusy: null });
    }
  },

  stashPush: async (message = null) => {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "No repository open" });
      return false;
    }
    if (gitBusy !== null) return false;
    const repoId = repo.id;
    set({ gitBusy: "stash", error: null, notice: null });
    try {
      const res = await api.stashPush(repoId, message ?? null);
      if (get().repo?.id !== repoId) return false;
      set({ repo: res.repo });
      await get().loadFileStatus();
      await get().loadStashes();
      if (get().error === null) {
        const summary = lastOutputLine(res.output);
        set({ notice: `贮藏完成${summary ? `：${summary}` : ""}` });
        return true;
      }
      return false;
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
      return false;
    } finally {
      set({ gitBusy: null });
    }
  },

  stashApply: async (index, pop) => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "stash", error: null, notice: null });
    try {
      const res = await api.stashApply(repoId, index, pop);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().loadFileStatus();
      await get().loadStashes();
      if (get().error === null) {
        set({ notice: `${pop ? "已弹出" : "已应用"} stash@{${index}}` });
      }
    } catch (e) {
      if (get().repo?.id !== repoId) return;
      set({ error: toErrorMessage(e) });
      await get().loadFileStatus();
      await get().loadStashes();
    } finally {
      set({ gitBusy: null });
    }
  },

  stashDrop: async (index) => {
    const { repo, gitBusy } = get();
    if (!repo) return set({ error: "No repository open" });
    if (gitBusy !== null) return;
    const repoId = repo.id;
    set({ gitBusy: "stash", error: null, notice: null });
    try {
      const res = await api.stashDrop(repoId, index);
      if (get().repo?.id !== repoId) return;
      set({ repo: res.repo });
      await get().loadStashes();
      if (get().error === null) {
        set({ notice: `已删除 stash@{${index}}` });
      }
    } catch (e) {
      if (get().repo?.id === repoId) set({ error: toErrorMessage(e) });
    } finally {
      set({ gitBusy: null });
    }
  },

  dismissNotice: () => set({ notice: null }),
  goBackToLog: () => {
    set({
      activeView: "log",
      diffScope: null,
      diffFiles: [],
      selectedDiffFileIndex: 0,
      currentFileDiff: null,
    });
  },

  setTheme: (t) => {
    persistTheme(t);
    set({ theme: t });
  },

  setLogFilter: (f) => {
    set({ logFilter: f });
    void get().reloadGraph();
  },
}));
