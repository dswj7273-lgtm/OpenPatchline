/**
 * 全局 Zustand Store 类型与 Slice 共享辅助函数。
 */

import type { StateCreator } from "zustand";
import { isCancelledError, reportError } from "../utils/errors";
import type {
  BranchInfo,
  ChangedFile,
  ChildRepo,
  CommitGraphRow,
  DiffScope,
  FileDiffResult,
  FileStatus,
  GitProgressEvent,
  LogFilter,
  RecentRepo,
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
  | "conflict"
  | "tag"
  | "cherryPick"
  | "revert"
  | "reset"
  | "discard"
  | "amend"
  | "stash"
  | null;

/** 提交图每页条数（docs/03 §7：分页加载）。 */
export const GRAPH_PAGE_SIZE = 100;

/** 空的日志过滤器。 */
export const EMPTY_LOG_FILTER: LogFilter = {
  branch: null,
  author: null,
  query: null,
  since: null,
  until: null,
};

/** 读取本地持久化的主题偏好（不可用时回退深色），并同步到根元素避免首帧闪烁。 */
export function readInitialTheme(): Theme {
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
export function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem("openpatchline:theme", theme);
  } catch {
    /* 忽略 */
  }
}

/** 取 git 输出的最后一行作为通知摘要（"Already up to date." 等）。 */
export function lastOutputLine(output: string): string | null {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line ?? null;
}

export { isCancelledError, reportError };

export interface RepoSlice {
  repo: RepoInfo | null;
  recentRepos: RecentRepo[];
  repoCandidates: { path: string; candidates: ChildRepo[] } | null;
  theme: Theme;
  error: string | null;
  notice: string | null;
  openRepo: (path?: string) => Promise<void>;
  refreshRepoInfo: () => Promise<void>;
  loadRecentRepos: () => Promise<void>;
  removeRecentRepo: (path: string) => Promise<void>;
  dismissRepoCandidates: () => void;
  dismissNotice: () => void;
  clearError: () => void;
  setTheme: (t: Theme) => void;
}

export interface LogSlice {
  graphRows: CommitGraphRow[];
  nextCursor: string | null;
  hasMore: boolean;
  graphLoading: boolean;
  logFilter: LogFilter;
  selectedCommitId: string | null;
  commitFiles: ChangedFile[];
  loadMoreCommits: () => Promise<void>;
  reloadGraph: () => Promise<void>;
  selectCommit: (id: string | null) => Promise<void>;
  setLogFilter: (f: LogFilter) => void;
}

export interface DiffSlice {
  activeView: ActiveView;
  diffScope: DiffScope | null;
  diffFiles: ChangedFile[];
  selectedDiffFileIndex: number;
  currentFileDiff: FileDiffResult | null;
  diffLoading: boolean;
  openFileDiff: (scope: DiffScope, files: ChangedFile[], index: number) => Promise<void>;
  showDiffFile: (index: number) => Promise<void>;
  nextDiffFile: () => Promise<void>;
  prevDiffFile: () => Promise<void>;
  goBackToLog: () => void;
}

export interface WorkspaceSlice {
  fileStatus: FileStatus[];
  branches: BranchInfo[];
  branchesLoading: boolean;
  stashes: StashEntry[];
  gitBusy: GitBusy;
  remoteProgress: { op: string; message: string; percent: number | null } | null;
  loadFileStatus: () => Promise<void>;
  stageFile: (path: string) => Promise<void>;
  stageFiles: (paths: string[]) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  unstageFiles: (paths: string[]) => Promise<void>;
  createCommit: (message: string) => Promise<void>;
  loadBranches: () => Promise<void>;
  checkoutBranch: (name: string) => Promise<void>;
  fetchRemote: () => Promise<void>;
  pullRepo: () => Promise<void>;
  pushRepo: () => Promise<void>;
  loadStashes: () => Promise<void>;
  fetchAll: () => Promise<void>;
  pullRebase: () => Promise<void>;
  pushForceWithLease: () => Promise<void>;
  pushTags: () => Promise<void>;
  cancelRemoteOp: () => Promise<void>;
  setRemoteProgress: (ev: GitProgressEvent) => void;
  createBranch: (name: string, startPoint?: string | null, checkout?: boolean) => Promise<boolean>;
  deleteBranch: (name: string, force?: boolean) => Promise<void>;
  mergeBranch: (name: string) => Promise<void>;
  abortOperation: () => Promise<void>;
  continueOperation: () => Promise<void>;
  createTag: (name: string, target?: string | null) => Promise<boolean>;
  cherryPickCommit: (commitId: string) => Promise<void>;
  revertCommit: (commitId: string) => Promise<void>;
  resetHead: (target: string, mode: ResetMode) => Promise<void>;
  discardFile: (path: string) => Promise<void>;
  discardAllChanges: () => Promise<void>;
  amendCommit: (message: string) => Promise<boolean>;
  stashPush: (message?: string | null) => Promise<boolean>;
  stashApply: (index: number, pop: boolean) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;
}

export type AppState = RepoSlice & LogSlice & DiffSlice & WorkspaceSlice;

export type AppSlice<T> = StateCreator<AppState, [], [], T>;
