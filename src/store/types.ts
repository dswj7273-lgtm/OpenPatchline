/**
 * 全局 Zustand Store 类型与 Slice 共享辅助函数。
 */

import type { StateCreator } from "zustand";
import { isCancelledError, reportError } from "../utils/errors";
import type {
  AppSettings,
  BranchInfo,
  ChangedFile,
  ChildRepo,
  CommitGraphRow,
  CommitMetadata,
  CommitSignatureInfo,
  CompareRange,
  ConflictFileDetail,
  DiffLineSelection,
  DiffPatchAction,
  DiffScope,
  FileBlameResult,
  FileDiffResult,
  FileStatus,
  GitProgressEvent,
  LogFilter,
  RebaseCommitEntry,
  RebasePlanEntry,
  RecentRepo,
  RepoInfo,
  ResetMode,
  StashEntry,
  Theme,
  ThemePreference,
} from "../types";

/** 主区域视图。 */
export type ActiveView = "log" | "diff" | "conflict" | "blame";

export type { Theme, ThemePreference };

/** 进行中的 git 操作，用于互斥与按钮态。 */
export type GitBusy =
  | "fetch"
  | "pull"
  | "push"
  | "checkout"
  | "branch"
  | "merge"
  | "conflict"
  | "resolve"
  | "tag"
  | "cherryPick"
  | "revert"
  | "reset"
  | "discard"
  | "amend"
  | "stash"
  | "rebase"
  | "patch"
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

/** 读取本地持久化的主题偏好（不可用时回退深色），并同步到根元素避免首帧闪烁。
 *  仅供设置加载完成前的首帧提示；正式状态以 settingsSlice 为准。 */
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
  error: string | null;
  notice: string | null;
  openRepo: (path?: string) => Promise<void>;
  refreshRepoInfo: () => Promise<void>;
  loadRecentRepos: () => Promise<void>;
  removeRecentRepo: (path: string) => Promise<void>;
  dismissRepoCandidates: () => void;
  dismissNotice: () => void;
  clearError: () => void;
}

/** 应用设置与主题（v0.6 / 6.2；theme 为解析后的生效值）。 */
export interface SettingsSlice {
  settings: AppSettings;
  settingsLoaded: boolean;
  theme: Theme;
  /** 代码行高（px），由字号设置派生，供虚拟滚动定位与 CSS 变量共用。 */
  codeRowHeight: number;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setTheme: (pref: ThemePreference) => void;
  toggleTheme: () => void;
  /** 系统主题偏好变化时同步生效主题（仅 theme=system 时有作用）。 */
  syncSystemTheme: () => void;
}

/** 全局浮层 UI（设置弹窗 / 命令面板 / 轻量 Rebase 弹窗）。 */
export interface UiSlice {
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  rebaseModalOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  openRebaseModal: () => void;
  closeRebaseModal: () => void;
}

export interface LogSlice {
  graphRows: CommitGraphRow[];
  nextCursor: string | null;
  hasMore: boolean;
  graphLoading: boolean;
  logFilter: LogFilter;
  selectedCommitId: string | null;
  commitFiles: ChangedFile[];
  commitSignature: CommitSignatureInfo | null;
  compareRange: CompareRange | null;
  rangeFiles: ChangedFile[];
  /** ⌘F 聚焦搜索框的自增计数（值变化触发 GitLogView 聚焦）。 */
  searchFocusTick: number;
  loadMoreCommits: () => Promise<void>;
  reloadGraph: () => Promise<void>;
  selectCommit: (id: string | null) => Promise<void>;
  toggleCommitForCompare: (id: string) => Promise<void>;
  compareCommits: (
    baseRef: string,
    targetRef: string,
    baseLabel?: string,
    targetLabel?: string,
  ) => Promise<void>;
  compareBranchWithCurrent: (branchName: string) => Promise<void>;
  swapCompareRange: () => Promise<void>;
  clearCompareRange: () => void;
  setLogFilter: (f: LogFilter) => void;
  focusSearch: () => void;
}

export interface DiffSlice {
  activeView: ActiveView;
  diffScope: DiffScope | null;
  diffFiles: ChangedFile[];
  selectedDiffFileIndex: number;
  currentFileDiff: FileDiffResult | null;
  diffLoading: boolean;
  /** 视图级忽略空白覆盖；null = 跟随设置默认值。 */
  diffIgnoreWhitespace: boolean | null;
  conflictPath: string | null;
  conflictDetail: ConflictFileDetail | null;
  conflictLoading: boolean;
  blameResult: FileBlameResult | null;
  blameLoading: boolean;
  blameHistory: Array<{ path: string; commitId: string | null }>;
  blameReturnView: "log" | "diff";
  openFileDiff: (scope: DiffScope, files: ChangedFile[], index: number) => Promise<void>;
  showDiffFile: (index: number) => Promise<void>;
  /** 切换忽略空白并重载当前文件 diff。 */
  setDiffIgnoreWhitespace: (v: boolean) => Promise<void>;
  nextDiffFile: () => Promise<void>;
  prevDiffFile: () => Promise<void>;
  goBackToLog: () => void;
  applyDiffSelection: (
    action: DiffPatchAction,
    selections: DiffLineSelection[],
  ) => Promise<boolean>;
  openConflictFile: (path: string) => Promise<void>;
  resolveConflictFile: (
    path: string,
    content: string,
    stage: boolean,
    deleteFile?: boolean,
  ) => Promise<boolean>;
  openFileBlame: (
    path: string,
    commitId?: string | null,
    opts?: { pushHistory?: boolean; returnView?: "log" | "diff" },
  ) => Promise<void>;
  goBackBlame: () => Promise<void>;
  closeBlame: () => void;
}

export interface WorkspaceSlice {
  fileStatus: FileStatus[];
  branches: BranchInfo[];
  branchesLoading: boolean;
  stashes: StashEntry[];
  commitMetadata: CommitMetadata | null;
  commitHistory: string[];
  gitBusy: GitBusy;
  pendingRepoRefresh: string | null;
  remoteProgress: { op: string; message: string; percent: number | null } | null;
  handleRepoStatusChanged: (repoId: string) => void;
  loadFileStatus: () => Promise<void>;
  loadCommitMetadata: () => Promise<void>;
  stageFile: (path: string) => Promise<void>;
  stageFiles: (paths: string[]) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  unstageFiles: (paths: string[]) => Promise<void>;
  createCommit: (message: string, sign?: boolean | null) => Promise<void>;
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
  listRebaseCommits: (limit?: number) => Promise<RebaseCommitEntry[]>;
  rewriteRecentCommits: (plan: RebasePlanEntry[]) => Promise<boolean>;
}

export type AppState = RepoSlice & LogSlice & DiffSlice & WorkspaceSlice & SettingsSlice & UiSlice;

export type AppSlice<T> = StateCreator<AppState, [], [], T>;
