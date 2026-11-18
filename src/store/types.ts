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
  FileHistoryEntry,
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
  SafetyBackup,
  StashEntry,
  Theme,
  ThemePreference,
} from "../types";

/** 主区域视图。 */
export type ActiveView = "log" | "diff" | "conflict" | "blame" | "history";

/** Diff 视图关闭（Esc / 按钮）后返回的目标视图（v0.7）。 */
export type DiffReturnView = "log" | "history" | "blame";

/** Blame 视图关闭后返回的目标视图（v0.7：可来自文件历史）。 */
export type BlameReturnView = "log" | "diff" | "history";

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

/** 文件历史视图（v0.7 / 7.1）。 */
export interface HistorySlice {
  historyPath: string | null;
  historyEntries: FileHistoryEntry[];
  historyLoading: boolean;
  openFileHistory: (path: string) => Promise<void>;
  closeFileHistory: () => void;
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
  /** Diff 关闭后的返回视图：从历史 / Blame 打开时返回来源（v0.7）。 */
  diffReturnView: DiffReturnView;
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
  blameReturnView: BlameReturnView;
  openFileDiff: (
    scope: DiffScope,
    files: ChangedFile[],
    index: number,
    opts?: { returnView?: DiffReturnView },
  ) => Promise<void>;
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
    opts?: { pushHistory?: boolean; returnView?: BlameReturnView },
  ) => Promise<void>;
  goBackBlame: () => Promise<void>;
  closeBlame: () => void;
}

export interface WorkspaceSlice {
  fileStatus: FileStatus[];
  branches: BranchInfo[];
  branchesLoading: boolean;
  stashes: StashEntry[];
  /** 危险操作备份引用（v0.8 / 8.5 撤销入口，随分支列表刷新）。 */
  safetyBackups: SafetyBackup[];
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
  /** 从命令面板恢复安全备份（review 修复统一入口）。 */
  restoreSafetyBackup: (fullRef: string) => Promise<void>;
  discardFile: (path: string) => Promise<void>;
  /** 从指定提交恢复单个文件（覆盖工作区，脏文件先拒绝，v0.7 / 7.7）。 */
  restoreFileFromCommit: (commitId: string, path: string) => Promise<boolean>;
  discardAllChanges: () => Promise<void>;
  amendCommit: (message: string) => Promise<boolean>;
  stashPush: (message?: string | null) => Promise<boolean>;
  stashApply: (index: number, pop: boolean) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;
  /** 预览贮藏条目差异（stash 提交 vs 基准父提交，v0.7 / 7.4）。 */
  previewStash: (index: number) => Promise<void>;
  /** 基于贮藏条目创建并切换分支（v0.7 / 7.4）。 */
  stashBranch: (name: string, index: number) => Promise<boolean>;
  listRebaseCommits: (limit?: number) => Promise<RebaseCommitEntry[]>;
  interactiveRebase: (plan: RebasePlanEntry[]) => Promise<boolean>;
}

export type AppState = RepoSlice &
  LogSlice &
  DiffSlice &
  WorkspaceSlice &
  SettingsSlice &
  UiSlice &
  HistorySlice;

export type AppSlice<T> = StateCreator<AppState, [], [], T>;
