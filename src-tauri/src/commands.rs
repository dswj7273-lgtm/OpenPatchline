//! Tauri Command 层（docs/03 §3）：把 repo_manager 持有的仓库与
//! git_service / graph / diff_engine 的能力封装为 `#[tauri::command]` 命令。
//!
//! 约定（与 src/api/client.ts 一一对应）：
//! - 参数 camelCase（Tauri 自动映射到 Rust 侧 snake_case 参数）；
//! - 返回 `Result<T, AppError>`，错误序列化为 `{ code, message }`；
//! - 命令均为 async：git 相关的阻塞工作放入
//!   [`tauri::async_runtime::spawn_blocking`]，仓库 `Mutex` 只在
//!   后台任务内持有、任务结束即释放。
//!
//! 命令清单：
//! - `pick_and_open_repository(path)` → `Option<RepoInfo>`（None = 用户取消选择）
//! - `get_commit_graph(repoId, cursor, limit, filter)` → `GraphPage`
//! - `get_commit_files(repoId, commitId)` → `Vec<ChangedFile>`
//! - `get_file_diff(repoId, scope, path)` → `FileDiffResult`
//! - `get_file_status(repoId)` → `Vec<FileStatus>`
//! - `stage_file(repoId, path)` / `unstage_file(repoId, path)` → `()`
//! - `create_commit(repoId, message)` → `String`（新提交 id）

use std::path::PathBuf;

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::git_service;
use crate::graph;
use crate::repo_manager::{lock_entry, RepoManager};
use crate::types::{
    ChangedFile, DiffScope, DiffScopeKind, FileDiffResult, FileStatus, GraphPage, LogFilter,
    OpenRepositoryOutcome, RepoInfo,
};

/// 提交图默认分页大小（调用方未显式传 limit 时）。
const DEFAULT_GRAPH_PAGE_SIZE: usize = 200;

/// 把后台任务 join 失败（panic / 取消）规整为 `AppError::Unexpected`。
fn join_error(err: tauri::Error) -> AppError {
    AppError::Unexpected(format!("后台任务执行失败: {err}"))
}

/// 打开仓库；`path` 为空时在 Rust 侧弹出原生目录选择框。
///
/// - 用户取消选择 → `OpenRepositoryOutcome::Cancelled`；
/// - `path` 非空时直接打开该路径（不经选择框）；
/// - 打开成功后登记到 [`RepoManager`] 并返回 `Opened(RepoInfo)`；
/// - 所选目录不是仓库 → `NotARepo`：附带其直接子目录中扫描到的候选
///   仓库（工作区目录场景），前端据此弹出选择列表。
///
/// 阻塞式文件夹对话框不能在主线程调用，整个流程放在
/// `spawn_blocking` 的阻塞线程上执行。
#[tauri::command]
pub async fn pick_and_open_repository(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    path: String,
) -> AppResult<OpenRepositoryOutcome> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<OpenRepositoryOutcome> {
        let dir = if path.trim().is_empty() {
            match app.dialog().file().blocking_pick_folder() {
                Some(picked) => picked.into_path().map_err(|e| {
                    AppError::Io(format!("所选目录路径无法解析: {e}"))
                })?,
                None => return Ok(OpenRepositoryOutcome::Cancelled), // 用户取消
            }
        } else {
            PathBuf::from(path)
        };
        match manager.open(&dir) {
            Ok(repo) => Ok(OpenRepositoryOutcome::Opened { repo }),
            Err(AppError::NotFound(_)) => {
                // 不是仓库：扫描直接子目录，让前端展示候选列表。
                let canonical =
                    std::fs::canonicalize(&dir).map_err(|e| {
                        AppError::Io(format!("解析路径 {} 失败: {e}", dir.display()))
                    })?;
                let candidates = git_service::list_child_repos(&canonical);
                Ok(OpenRepositoryOutcome::NotARepo {
                    path: canonical.to_string_lossy().into_owned(),
                    candidates,
                })
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(join_error)?
}

/// 分页读取提交历史并计算泳道图。
///
/// - `cursor`：上一页最后一条 commit id；`None` 表示首页（新图会话，
///   重置该仓库的泳道增量状态，避免旧会话的预留泳道泄漏进新图）；
/// - `limit`：本页条数，缺省 [`DEFAULT_GRAPH_PAGE_SIZE`]；
/// - `filter`：分支起点 / 作者 / message / 时间过滤。
///
/// `next_cursor` 为最后一行 commit id（`has_more` 为 false 时为 None）。
#[tauri::command]
pub async fn get_commit_graph(
    state: State<'_, RepoManager>,
    repo_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
    filter: Option<LogFilter>,
) -> AppResult<GraphPage> {
    let entry = state.inner().clone().entry(&repo_id)?;
    let limit = limit.unwrap_or(DEFAULT_GRAPH_PAGE_SIZE).max(1);
    let fresh_page = cursor.is_none();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GraphPage> {
        let mut entry = lock_entry(&entry);
        if fresh_page {
            entry.graph_state = graph::GraphState::new();
        }
        let (commits, has_more) = git_service::load_commit_page(
            &entry.repo,
            cursor.as_deref(),
            limit,
            filter.as_ref(),
        )?;
        let rows = entry.graph_state.compute_graph_rows(commits);
        let next_cursor = if has_more {
            rows.last().map(|row| row.commit.id.clone())
        } else {
            None
        };
        Ok(GraphPage {
            rows,
            next_cursor,
            has_more,
        })
    })
    .await
    .map_err(join_error)?
}

/// 某次提交（vs 第一个父提交）的变更文件列表。
#[tauri::command]
pub async fn get_commit_files(
    state: State<'_, RepoManager>,
    repo_id: String,
    commit_id: String,
) -> AppResult<Vec<ChangedFile>> {
    if commit_id.trim().is_empty() {
        return Err(AppError::InvalidArg("commitId 不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<ChangedFile>> {
        let entry = lock_entry(&entry);
        git_service::changed_files(&entry.repo, &commit_id)
    })
    .await
    .map_err(join_error)?
}

/// 按 `scope`（提交 / 暂存区 / 工作区）计算单个文件的左右分栏 diff。
#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, RepoManager>,
    repo_id: String,
    scope: DiffScope,
    path: String,
) -> AppResult<FileDiffResult> {
    if path.is_empty() {
        return Err(AppError::InvalidArg("path 不能为空".to_string()));
    }
    // commit 范围必须有 commitId（提前校验，避免后台任务白跑）。
    if matches!(scope.kind, DiffScopeKind::Commit)
        && scope.commit_id.as_deref().map_or(true, str::is_empty)
    {
        return Err(AppError::InvalidArg(
            "scope.kind 为 commit 时必须提供 commitId".to_string(),
        ));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<FileDiffResult> {
        let entry = lock_entry(&entry);
        match scope.kind {
            DiffScopeKind::Commit => git_service::file_diff_commit(
                &entry.repo,
                scope.commit_id.as_deref().unwrap_or_default(),
                &path,
            ),
            DiffScopeKind::Staged => git_service::file_diff_staged(&entry.repo, &path),
            DiffScopeKind::Workdir => git_service::file_diff_workdir(&entry.repo, &path),
        }
    })
    .await
    .map_err(join_error)?
}

/// 工作区文件状态（staged / unstaged 两栏）。
#[tauri::command]
pub async fn get_file_status(
    state: State<'_, RepoManager>,
    repo_id: String,
) -> AppResult<Vec<FileStatus>> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<FileStatus>> {
        let entry = lock_entry(&entry);
        git_service::status(&entry.repo)
    })
    .await
    .map_err(join_error)?
}

/// 暂存单个文件（工作区 → index）。
#[tauri::command]
pub async fn stage_file(
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
) -> AppResult<()> {
    if path.is_empty() {
        return Err(AppError::InvalidArg("path 不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let mut entry = lock_entry(&entry);
        git_service::stage_file(&mut entry.repo, &path)
    })
    .await
    .map_err(join_error)?
}

/// 取消暂存单个文件（index → HEAD）。
#[tauri::command]
pub async fn unstage_file(
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
) -> AppResult<()> {
    if path.is_empty() {
        return Err(AppError::InvalidArg("path 不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let mut entry = lock_entry(&entry);
        git_service::unstage_file(&mut entry.repo, &path)
    })
    .await
    .map_err(join_error)?
}

/// 提交当前暂存区，返回新提交 id。
#[tauri::command]
pub async fn create_commit(
    state: State<'_, RepoManager>,
    repo_id: String,
    message: String,
) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::InvalidArg("提交信息不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<String> {
        let mut entry = lock_entry(&entry);
        git_service::create_commit(&mut entry.repo, &message)
    })
    .await
    .map_err(join_error)?
}
