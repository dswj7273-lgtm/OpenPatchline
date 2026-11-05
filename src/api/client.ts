/**
 * Tauri IPC 客户端：按契约（src-tauri/src/commands.rs）封装 invoke 调用。
 *
 * - 命令参数一律 camelCase（Tauri 自动映射到 Rust 侧 snake_case 参数）；
 * - 类型与 src/types/index.ts 完全对应，组件/store 层不得直接调用 invoke。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  ChangedFile,
  DiffScope,
  FileDiffResult,
  FileStatus,
  GraphPage,
  LogFilter,
  OpenRepositoryOutcome,
} from "../types";

/**
 * 打开仓库。原生文件夹选择框在 Rust 侧弹出；
 * `path` 为空时弹出选择框，非空时直接打开该路径。
 * 返回 opened / cancelled / notARepo（附带子仓库候选列表）。
 */
export function openRepository(path: string): Promise<OpenRepositoryOutcome> {
  return invoke<OpenRepositoryOutcome>("pick_and_open_repository", { path });
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
