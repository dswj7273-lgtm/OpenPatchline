/**
 * Tauri IPC 客户端：按契约（src-tauri/src/commands.rs）封装 invoke 调用。
 *
 * - 命令参数一律 camelCase（Tauri 自动映射到 Rust 侧 snake_case 参数）；
 * - 类型与 src/types/index.ts 完全对应，组件/store 层不得直接调用 invoke。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  BranchInfo,
  ChangedFile,
  DiffScope,
  FetchResult,
  FileDiffResult,
  FileStatus,
  GitActionResult,
  GraphPage,
  LogFilter,
  OpenRepositoryOutcome,
  PullResult,
  PushResult,
  RecentRepo,
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

/** 按 scope 计算单个文件的左右分栏 diff。 */
export function getFileDiff(
  repoId: string,
  scope: DiffScope,
  path: string,
): Promise<FileDiffResult> {
  return invoke<FileDiffResult>("get_file_diff", { repoId, scope, path });
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

/** 提交当前暂存区，返回新提交 id。 */
export function createCommit(repoId: string, message: string): Promise<string> {
  return invoke<string>("create_commit", { repoId, message });
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
