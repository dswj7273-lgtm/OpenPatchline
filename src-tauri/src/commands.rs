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
//! - `list_branches(repoId)` → `Vec<BranchInfo>`
//! - `checkout_branch(repoId, name)` → `RepoInfo`（切换后的仓库信息）
//! - `fetch_repository(repoId, remote)` → `FetchResult`（git CLI 子进程）
//! - `pull_repository(repoId)` → `PullResult`（git CLI 子进程）
//! - `push_repository(repoId)` → `PushResult`（git CLI 子进程）

use std::path::PathBuf;

use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::git_remote::{self, RemoteOpManager, RemoteProgress};
use crate::git_service;
use crate::graph;
use crate::recent_repos;
use crate::repo_manager::{RepoManager, lock_entry};
use crate::types::{
    BranchInfo, ChangedFile, DiffScope, DiffScopeKind, FetchResult, FileDiffResult, FileStatus,
    GitActionResult, GitProgressEvent, GraphPage, LogFilter, OpenRepositoryOutcome, PullResult,
    PushResult, RecentRepo, RepoInfo, StashEntry,
};
use crate::watcher::RepoWatcher;

/// 远程操作实时进度事件名。
const GIT_REMOTE_PROGRESS_EVENT: &str = "git_remote_progress";

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
/// - 打开成功后登记到 [`RepoManager`] 并返回 `Opened(RepoInfo)`，
///   同时开始监听其 `.git` 目录（外部变更主动推送，见 [`crate::watcher`]）；
/// - 所选目录不是仓库 → `NotARepo`：附带其直接子目录中扫描到的候选
///   仓库（工作区目录场景），前端据此弹出选择列表。
///
/// 阻塞式文件夹对话框不能在主线程调用，整个流程放在
/// `spawn_blocking` 的阻塞线程上执行。
#[tauri::command]
pub async fn pick_and_open_repository(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    watcher: State<'_, RepoWatcher>,
    path: String,
) -> AppResult<OpenRepositoryOutcome> {
    let manager = state.inner().clone();
    let watcher = watcher.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<OpenRepositoryOutcome> {
        let dir = if path.trim().is_empty() {
            match app.dialog().file().blocking_pick_folder() {
                Some(picked) => picked
                    .into_path()
                    .map_err(|e| AppError::Io(format!("所选目录路径无法解析: {e}")))?,
                None => return Ok(OpenRepositoryOutcome::Cancelled), // 用户取消
            }
        } else {
            PathBuf::from(path)
        };
        match manager.open(&dir) {
            Ok(repo) => {
                // 监听 .git：失败不阻断打开（自动刷新退化为手动刷新）。
                if let Ok(entry) = manager.entry(&repo.id) {
                    let gitdir = lock_entry(&entry).repo.path().to_path_buf();
                    if let Err(e) = watcher.watch(&repo.id, &gitdir) {
                        eprintln!("[watcher] 监听 {} 失败: {e}", repo.id);
                    }
                }
                if let Ok(file) = recent_repos::recent_repos_file(&app)
                    && let Err(e) = recent_repos::record_recent_repo(
                        &file,
                        &repo,
                        recent_repos::now_unix_secs(),
                    )
                {
                    eprintln!("[recent_repos] 记录最近仓库失败: {e}");
                }
                Ok(OpenRepositoryOutcome::Opened { repo })
            }
            Err(AppError::NotFound(_)) => {
                // 不是仓库：扫描直接子目录，让前端展示候选列表。
                let canonical = std::fs::canonicalize(&dir)
                    .map_err(|e| AppError::Io(format!("解析路径 {} 失败: {e}", dir.display())))?;
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

/// 读取已打开仓库的最新元数据（分支 / HEAD / 冲突操作状态）。
#[tauri::command]
pub async fn get_repo_info(state: State<'_, RepoManager>, repo_id: String) -> AppResult<RepoInfo> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<RepoInfo> {
        let entry = lock_entry(&entry);
        git_service::repo_info(&entry.repo)
    })
    .await
    .map_err(join_error)?
}

/// 获取最近打开的仓库列表（自动清理失效路径）。
#[tauri::command]
pub async fn get_recent_repositories(app: tauri::AppHandle) -> AppResult<Vec<RecentRepo>> {
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<RecentRepo>> {
        let file = recent_repos::recent_repos_file(&app)?;
        recent_repos::load_recent_repos(&file)
    })
    .await
    .map_err(join_error)?
}

/// 从最近仓库列表中移除指定路径或 id。
#[tauri::command]
pub async fn remove_recent_repository(
    app: tauri::AppHandle,
    path: String,
) -> AppResult<Vec<RecentRepo>> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidArg("path 不能为空".to_string()));
    }
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<RecentRepo>> {
        let file = recent_repos::recent_repos_file(&app)?;
        recent_repos::remove_recent_repo(&file, path.trim())
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
        let (commits, has_more) =
            git_service::load_commit_page(&entry.repo, cursor.as_deref(), limit, filter.as_ref())?;
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
        && scope.commit_id.as_deref().is_none_or(str::is_empty)
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

/// 列出本地与远程分支（含当前标记、上游与 ahead/behind）。
#[tauri::command]
pub async fn list_branches(
    state: State<'_, RepoManager>,
    repo_id: String,
) -> AppResult<Vec<BranchInfo>> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<BranchInfo>> {
        let entry = lock_entry(&entry);
        git_service::list_branches(&entry.repo)
    })
    .await
    .map_err(join_error)?
}

/// 切换分支（本地分支直接切换；远程分支检出为新的本地跟踪分支），
/// 成功返回切换后的仓库信息。
#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, RepoManager>,
    repo_id: String,
    name: String,
) -> AppResult<RepoInfo> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidArg("分支名不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<RepoInfo> {
        let mut entry = lock_entry(&entry);
        git_service::checkout_branch(&mut entry.repo, &name)?;
        git_service::repo_info(&entry.repo)
    })
    .await
    .map_err(join_error)?
}

/// 仓库工作区路径；bare 仓库报错。
fn workdir_of(repo: &git2::Repository) -> AppResult<PathBuf> {
    repo.workdir()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))
}

/// 在后台线程锁定仓库条目并执行带流式进度推送的远程操作。
async fn run_remote_with_progress<T, F>(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
    op_kind: &'static str,
    task: F,
) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&git2::Repository, &std::path::Path, RemoteProgress<'_>) -> AppResult<T>
        + Send
        + 'static,
{
    let entry = state.inner().clone().entry(&repo_id)?;
    let ops = remote_ops.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<T> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        let emit = |line: &str, percent: Option<u8>| {
            let _ = app.emit(
                GIT_REMOTE_PROGRESS_EVENT,
                GitProgressEvent {
                    repo_id: repo_id.clone(),
                    op: op_kind.to_string(),
                    message: line.to_string(),
                    percent,
                },
            );
        };
        let progress = RemoteProgress {
            manager: &ops,
            repo_id: &repo_id,
            on_line: &emit,
        };
        task(&entry.repo, &workdir, progress)
    })
    .await
    .map_err(join_error)?
}

/// 从远程拉取（fetch，不合并）：更新远程跟踪分支（带流式进度与取消支持）。
#[tauri::command]
pub async fn fetch_repository(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
    remote: Option<String>,
) -> AppResult<FetchResult> {
    run_remote_with_progress(
        app,
        state,
        remote_ops,
        repo_id,
        "fetch",
        move |repo, workdir, p| {
            git_remote::fetch_with_progress(repo, workdir, remote.as_deref(), Some(p))
        },
    )
    .await
}

/// 拉取并合并到当前分支（pull，遵循仓库 merge/rebase 配置）。
#[tauri::command]
pub async fn pull_repository(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
) -> AppResult<PullResult> {
    run_remote_with_progress(
        app,
        state,
        remote_ops,
        repo_id,
        "pull",
        |repo, workdir, p| git_remote::pull_with_progress(repo, workdir, Some(p)),
    )
    .await
}

/// 推送当前分支（push；无上游时建立跟踪后推送）。
#[tauri::command]
pub async fn push_repository(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
) -> AppResult<PushResult> {
    run_remote_with_progress(
        app,
        state,
        remote_ops,
        repo_id,
        "push",
        |repo, workdir, p| git_remote::push_with_progress(repo, workdir, Some(p)),
    )
    .await
}

#[tauri::command]
pub async fn fetch_all_remotes(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
) -> AppResult<GitActionResult> {
    run_remote_with_progress(
        app,
        state,
        remote_ops,
        repo_id,
        "fetch",
        |repo, workdir, p| git_remote::fetch_all_with_progress(repo, workdir, Some(p)),
    )
    .await
}

#[tauri::command]
pub async fn pull_rebase_repository(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
) -> AppResult<PullResult> {
    run_remote_with_progress(
        app,
        state,
        remote_ops,
        repo_id,
        "pull",
        |repo, workdir, p| git_remote::pull_rebase_with_progress(repo, workdir, Some(p)),
    )
    .await
}

#[tauri::command]
pub async fn push_force_with_lease_repository(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
) -> AppResult<PushResult> {
    run_remote_with_progress(
        app,
        state,
        remote_ops,
        repo_id,
        "push",
        |repo, workdir, p| git_remote::push_force_with_lease_with_progress(repo, workdir, Some(p)),
    )
    .await
}

#[tauri::command]
pub async fn push_tags_repository(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
) -> AppResult<PushResult> {
    run_remote_with_progress(
        app,
        state,
        remote_ops,
        repo_id,
        "push",
        |repo, workdir, p| git_remote::push_tags_with_progress(repo, workdir, Some(p)),
    )
    .await
}

/// 取消指定仓库正在执行的远程操作（无锁等待，立即终止 git 子进程树）。
#[tauri::command]
pub async fn cancel_remote_operation(
    remote_ops: State<'_, RemoteOpManager>,
    repo_id: String,
) -> AppResult<bool> {
    Ok(remote_ops.cancel(&repo_id))
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::create_branch(
            &entry.repo,
            &workdir,
            &name,
            start_point.as_deref(),
            checkout,
        )
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn delete_branch(
    state: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    force: bool,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::delete_branch(&entry.repo, &workdir, &name, force)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn merge_branch(
    state: State<'_, RepoManager>,
    repo_id: String,
    name: String,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::merge_branch(&entry.repo, &workdir, &name)
    })
    .await
    .map_err(join_error)?
}

/// 中止进行中的合并 / 变基 / cherry-pick / revert。
#[tauri::command]
pub async fn abort_operation(
    state: State<'_, RepoManager>,
    repo_id: String,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::abort_operation(&entry.repo, &workdir)
    })
    .await
    .map_err(join_error)?
}

/// 解决冲突后继续进行中的合并 / 变基 / cherry-pick / revert。
#[tauri::command]
pub async fn continue_operation(
    state: State<'_, RepoManager>,
    repo_id: String,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::continue_operation(&entry.repo, &workdir)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    target: Option<String>,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::create_tag(&entry.repo, &workdir, &name, target.as_deref())
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn cherry_pick_commit(
    state: State<'_, RepoManager>,
    repo_id: String,
    commit_id: String,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::cherry_pick_commit(&entry.repo, &workdir, &commit_id)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn revert_commit(
    state: State<'_, RepoManager>,
    repo_id: String,
    commit_id: String,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::revert_commit(&entry.repo, &workdir, &commit_id)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn reset_head(
    state: State<'_, RepoManager>,
    repo_id: String,
    target: String,
    mode: String,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::reset_head(&entry.repo, &workdir, &target, &mode)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn discard_file(
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
) -> AppResult<()> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::discard_file(&entry.repo, &workdir, &path)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn discard_all(
    state: State<'_, RepoManager>,
    repo_id: String,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::discard_all(&entry.repo, &workdir)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn amend_commit(
    state: State<'_, RepoManager>,
    repo_id: String,
    message: String,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::amend_commit(&entry.repo, &workdir, &message)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn list_stashes(
    state: State<'_, RepoManager>,
    repo_id: String,
) -> AppResult<Vec<StashEntry>> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<StashEntry>> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::list_stashes(&workdir)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn stash_push(
    state: State<'_, RepoManager>,
    repo_id: String,
    message: Option<String>,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::stash_push(&entry.repo, &workdir, message.as_deref())
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn stash_apply(
    state: State<'_, RepoManager>,
    repo_id: String,
    index: usize,
    pop: bool,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::stash_apply(&entry.repo, &workdir, index, pop)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn stash_drop(
    state: State<'_, RepoManager>,
    repo_id: String,
    index: usize,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::stash_drop(&entry.repo, &workdir, index)
    })
    .await
    .map_err(join_error)?
}
