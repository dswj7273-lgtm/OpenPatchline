/**
 * Tauri IPC 客户端：按契约（src-tauri/src/commands.rs）封装 invoke 调用。
 *
 * - 命令参数一律 camelCase（Tauri 自动映射到 Rust 侧 snake_case 参数）；
 * - 类型与 src/types/index.ts 完全对应，组件/store 层不得直接调用 invoke。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  BranchInfo,
  ChangedFile,
  CommitMetadata,
  CommitSignatureInfo,
  ConflictFileDetail,
  DiffLineSelection,
  DiffPatchAction,
  DiffScope,
  FetchResult,
  FileBlameResult,
  FileDiffResult,
  FileHistoryEntry,
  FileStatus,
  GitActionResult,
  GraphPage,
  LogFilter,
  OpenRepositoryOutcome,
  PullResult,
  PushResult,
  RebaseCommitEntry,
  RebasePlanEntry,
  RecentRepo,
  SafetyBackup,
  RepoInfo,
  ResetMode,
  StashEntry,
} from "../types";

/**
 * 打开仓库。原生文件夹选择框在 Rust 侧弹出；
 * `path` 为空时弹出选择框，非空时直接打开该路径。
 * 返回 opened / cancelled / notARepo（附带子仓库候选列表）。
 */
export function openRepository(path: string): Promise<OpenRepositoryOutcome> {
  return invoke<OpenRepositoryOutcome>("pick_and_open_repository", { path });
}

/** 读取已打开仓库的最新元数据（分支 / HEAD / 冲突状态）。 */
export function getRepoInfo(repoId: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("get_repo_info", { repoId });
}

/** 获取最近打开的仓库列表（后端自动清理失效路径）。 */
export function getRecentRepositories(): Promise<RecentRepo[]> {
  return invoke<RecentRepo[]>("get_recent_repositories");
}

/** 从最近仓库列表中移除指定路径。 */
export function removeRecentRepository(path: string): Promise<RecentRepo[]> {
  return invoke<RecentRepo[]>("remove_recent_repository", { path });
}

/** 分页读取提交图；cursor 为上一页最后一条 commit id（首页传 null）。 */
export function getCommitGraph(
  repoId: string,
  cursor: string | null,
  limit: number,
  filter: LogFilter | null,
): Promise<GraphPage> {
  return invoke<GraphPage>("get_commit_graph", { repoId, cursor, limit, filter });
}

/** 某次提交（vs 第一个父提交）的变更文件列表。 */
export function getCommitFiles(repoId: string, commitId: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("get_commit_files", { repoId, commitId });
}

/** 两个提交或引用之间的变更文件列表（baseRef → targetRef）。 */
export function getRangeFiles(
  repoId: string,
  baseRef: string,
  targetRef: string,
): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("get_range_files", { repoId, baseRef, targetRef });
}

/** 按 scope 计算单个文件的左右分栏 diff；ignoreWhitespace 为 true 时忽略空白差异。 */
export function getFileDiff(
  repoId: string,
  scope: DiffScope,
  path: string,
  ignoreWhitespace = false,
): Promise<FileDiffResult> {
  return invoke<FileDiffResult>("get_file_diff", {
    repoId,
    scope,
    path,
    ignoreWhitespace,
  });
}

/** 对工作区或暂存区 diff 应用 hunk / 行级局部暂存、取消暂存或丢弃。
 *  ignoreWhitespace 必须与视图加载时一致，保证选区行下标对齐。 */
export function applyDiffSelection(
  repoId: string,
  scope: DiffScope,
  path: string,
  action: DiffPatchAction,
  selections: DiffLineSelection[],
  ignoreWhitespace = false,
): Promise<void> {
  return invoke<void>("apply_diff_selection", {
    repoId,
    scope,
    path,
    action,
    selections,
    ignoreWhitespace,
  });
}

/** 工作区文件状态（staged / unstaged）。 */
export function getFileStatus(repoId: string): Promise<FileStatus[]> {
  return invoke<FileStatus[]>("get_file_status", { repoId });
}

/** 暂存单个文件。 */
export function stageFile(repoId: string, path: string): Promise<void> {
  return invoke<void>("stage_file", { repoId, path });
}

/** 取消暂存单个文件。 */
export function unstageFile(repoId: string, path: string): Promise<void> {
  return invoke<void>("unstage_file", { repoId, path });
}

/** 提交当前暂存区，返回新提交 id（可选强制开启或关闭签名）。 */
export function createCommit(
  repoId: string,
  message: string,
  sign: boolean | null = null,
): Promise<string> {
  return invoke<string>("create_commit", { repoId, message, sign });
}

/** 读取提交模板与签名配置元数据。 */
export function getCommitMetadata(repoId: string): Promise<CommitMetadata> {
  return invoke<CommitMetadata>("get_commit_metadata", { repoId });
}

/** 校验指定提交的 GPG / SSH 签名状态。 */
export function getCommitSignature(repoId: string, commitId: string): Promise<CommitSignatureInfo> {
  return invoke<CommitSignatureInfo>("get_commit_signature", { repoId, commitId });
}

/** 获取最近可整理的非合并提交列表（从旧到新）。 */
export function listRebaseCommits(repoId: string, limit = 20): Promise<RebaseCommitEntry[]> {
  return invoke<RebaseCommitEntry[]>("list_rebase_commits", { repoId, limit });
}

/**
 * 执行交互式变基（Pick / Reword / Squash / Fixup / Drop + 任意顺序）。
 * 无重排且无丢弃时后端自动走无冲突轻量路径；含重排/丢弃时委托
 * `git rebase -i`，执行前创建备份引用 refs/opl-backup/rebase。
 */
export function interactiveRebase(
  repoId: string,
  plan: RebasePlanEntry[],
): Promise<GitActionResult> {
  return invoke<GitActionResult>("interactive_rebase", { repoId, plan });
}

/** 列出危险操作备份引用（撤销入口数据源，v0.8 / 8.5）。 */
export function listSafetyBackups(repoId: string): Promise<SafetyBackup[]> {
  return invoke<SafetyBackup[]>("list_safety_backups", { repoId });
}

/** 从命令面板恢复安全备份（review 修复统一入口）。 */
export function restoreSafetyBackup(repoId: string, fullRef: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("restore_safety_backup", { repoId, fullRef });
}

/** 组装诊断信息文本（v0.8 / 8.7）。 */
export function getDiagnostics(): Promise<string> {
  return invoke<string>("get_diagnostics");
}

/** 在 Finder 中定位日志文件（v0.8 / 8.7）。 */
export function revealLogFile(): Promise<void> {
  return invoke<void>("reveal_log_file");
}

/** 从指定提交恢复单个文件到工作区并暂存（v0.7 / 7.7）。 */
export function checkoutFileFrom(
  repoId: string,
  commitId: string,
  path: string,
): Promise<GitActionResult> {
  return invoke<GitActionResult>("checkout_file_from", { repoId, commitId, path });
}

/** 列出本地与远程分支（含当前标记、上游与 ahead/behind）。 */
export function listBranches(repoId: string): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>("list_branches", { repoId });
}

/** 切换分支（本地直接切换；远程检出为新的本地跟踪分支），返回切换后的仓库信息。 */
export function checkoutBranch(repoId: string, name: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("checkout_branch", { repoId, name });
}

/** 从远程拉取（fetch，不合并）；remote 为 null 时取默认远程（origin 优先）。 */
export function fetchRepository(repoId: string, remote: string | null): Promise<FetchResult> {
  return invoke<FetchResult>("fetch_repository", { repoId, remote });
}

/** 拉取并合并到当前分支（pull，遵循仓库 merge/rebase 配置）。 */
export function pullRepository(repoId: string): Promise<PullResult> {
  return invoke<PullResult>("pull_repository", { repoId });
}

/** 推送当前分支（push；无上游时建立跟踪后推送）。 */
export function pushRepository(repoId: string): Promise<PushResult> {
  return invoke<PushResult>("push_repository", { repoId });
}

/** 获取全部远程并清理失效远程分支。 */
export function fetchAllRemotes(repoId: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("fetch_all_remotes", { repoId });
}

/** 使用 rebase + autostash 拉取当前分支。 */
export function pullRebaseRepository(repoId: string): Promise<PullResult> {
  return invoke<PullResult>("pull_rebase_repository", { repoId });
}

/** 安全强推当前分支（--force-with-lease）。 */
export function pushForceWithLeaseRepository(repoId: string): Promise<PushResult> {
  return invoke<PushResult>("push_force_with_lease_repository", { repoId });
}

/** 推送全部本地标签到默认远程。 */
export function pushTagsRepository(repoId: string): Promise<PushResult> {
  return invoke<PushResult>("push_tags_repository", { repoId });
}

/** 取消指定仓库正在执行的远程操作。 */
export function cancelRemoteOperation(repoId: string): Promise<boolean> {
  return invoke<boolean>("cancel_remote_operation", { repoId });
}

/** 创建本地分支（可选基于 startPoint 与立即切换）。 */
export function createBranch(
  repoId: string,
  name: string,
  startPoint: string | null,
  checkout: boolean,
): Promise<GitActionResult> {
  return invoke<GitActionResult>("create_branch", { repoId, name, startPoint, checkout });
}

/** 删除本地分支。 */
export function deleteBranch(
  repoId: string,
  name: string,
  force: boolean,
): Promise<GitActionResult> {
  return invoke<GitActionResult>("delete_branch", { repoId, name, force });
}

/** 合并指定分支到当前分支。 */
export function mergeBranch(repoId: string, name: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("merge_branch", { repoId, name });
}

/** 中止进行中的合并 / 变基 / cherry-pick / revert。 */
export function abortOperation(repoId: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("abort_operation", { repoId });
}

/** 解决冲突后继续进行中的合并 / 变基 / cherry-pick / revert。 */
export function continueOperation(repoId: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("continue_operation", { repoId });
}

/** 创建标签。 */
export function createTag(
  repoId: string,
  name: string,
  target: string | null,
): Promise<GitActionResult> {
  return invoke<GitActionResult>("create_tag", { repoId, name, target });
}

/** 挑选提交到当前分支（cherry-pick）。 */
export function cherryPickCommit(repoId: string, commitId: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("cherry_pick_commit", { repoId, commitId });
}

/** 生成反向提交撤销指定提交（revert）。 */
export function revertCommit(repoId: string, commitId: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("revert_commit", { repoId, commitId });
}

/** 重置 HEAD 到指定目标提交。 */
export function resetHead(
  repoId: string,
  target: string,
  mode: ResetMode,
): Promise<GitActionResult> {
  return invoke<GitActionResult>("reset_head", { repoId, target, mode });
}

/** 丢弃单个未暂存或未跟踪文件的更改。 */
export function discardFile(repoId: string, path: string): Promise<void> {
  return invoke<void>("discard_file", { repoId, path });
}

/** 丢弃工作区与暂存区的全部更改。 */
export function discardAll(repoId: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("discard_all", { repoId });
}

/** 修正最近一次提交。 */
export function amendCommit(repoId: string, message: string): Promise<GitActionResult> {
  return invoke<GitActionResult>("amend_commit", { repoId, message });
}

/** 列出贮藏栈条目。 */
export function listStashes(repoId: string): Promise<StashEntry[]> {
  return invoke<StashEntry[]>("list_stashes", { repoId });
}

/** 贮藏当前更改与未跟踪文件。 */
export function stashPush(repoId: string, message: string | null): Promise<GitActionResult> {
  return invoke<GitActionResult>("stash_push", { repoId, message });
}

/** 应用或弹出指定贮藏条目。 */
export function stashApply(repoId: string, index: number, pop: boolean): Promise<GitActionResult> {
  return invoke<GitActionResult>("stash_apply", { repoId, index, pop });
}

/** 删除指定贮藏条目。 */
export function stashDrop(repoId: string, index: number): Promise<GitActionResult> {
  return invoke<GitActionResult>("stash_drop", { repoId, index });
}

/** 记录前端错误/告警日志到本地日志文件。 */
export function logClientError(level: string, source: string, message: string): Promise<void> {
  return invoke<void>("log_client_error", { level, source, message });
}

/** 获取本地日志文件路径。 */
export function getLogFilePath(): Promise<string> {
  return invoke<string>("get_log_file_path");
}

/** 读取冲突文件的三方内容与当前工作区快照。 */
export function getConflictFile(repoId: string, path: string): Promise<ConflictFileDetail> {
  return invoke<ConflictFileDetail>("get_conflict_file", { repoId, path });
}

/** 写入冲突解决结果并按需标记为已解决（暂存）。 */
export function resolveConflictFile(
  repoId: string,
  path: string,
  content: string,
  stage: boolean,
  deleteFile = false,
): Promise<void> {
  return invoke<void>("resolve_conflict_file", { repoId, path, content, stage, deleteFile });
}

/** 计算指定文件在给定提交或工作区下的逐行 Blame。 */
export function getFileBlame(
  repoId: string,
  path: string,
  commitId: string | null = null,
): Promise<FileBlameResult> {
  return invoke<FileBlameResult>("get_file_blame", { repoId, path, commitId });
}

/** 读取应用设置；fresh 为 true 表示尚未持久化过（首次运行）。 */
export function getAppSettings(): Promise<{ config: AppSettings; fresh: boolean }> {
  return invoke<{ config: AppSettings; fresh: boolean }>("get_app_config");
}

/** 保存应用设置（后端会规整取值），返回落盘后的最终配置。 */
export function setAppSettings(config: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("set_app_config", { config });
}

/** 在 Finder 中定位仓库内文件。 */
export function revealPathInFinder(repoId: string, path: string): Promise<void> {
  return invoke<void>("reveal_path_in_finder", { repoId, path });
}

/** 用设置中的外部编辑器打开文件（可选跳转到行号）。 */
export function openFileInEditor(
  repoId: string,
  path: string,
  line: number | null = null,
): Promise<void> {
  return invoke<void>("open_file_in_editor", { repoId, path, line });
}

/** 读取单个文件的提交历史（--follow 跨重命名追踪）。 */
export function getFileHistory(
  repoId: string,
  path: string,
  limit = 500,
): Promise<FileHistoryEntry[]> {
  return invoke<FileHistoryEntry[]>("get_file_history", { repoId, path, limit });
}

/** 基于贮藏条目创建并切换分支（建分支 + 检出 + 应用，成功后弹出）。 */
export function stashBranch(repoId: string, name: string, index: number): Promise<GitActionResult> {
  return invoke<GitActionResult>("stash_branch", { repoId, name, index });
}

/** 列出包含指定提交的分支（本地 + 远程）。 */
export function listBranchesContaining(repoId: string, commitId: string): Promise<string[]> {
  return invoke<string[]>("list_branches_containing", { repoId, commitId });
}

/** 列出贮藏条目的变更文件（stash 提交 vs 基准父提交）。 */
export function getStashFiles(repoId: string, index: number): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("get_stash_files", { repoId, index });
}

/** 弹出原生文件选择框选取 git 可执行文件；取消返回 null。 */
export function pickGitExecutable(): Promise<string | null> {
  return invoke<string | null>("pick_git_executable");
}

/** 生成工作区 / 暂存区单文件的 unified patch 文本。 */
export function generateFilePatch(repoId: string, scope: DiffScope, path: string): Promise<string> {
  return invoke<string>("generate_file_patch", { repoId, scope, path });
}
