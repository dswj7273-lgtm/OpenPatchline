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

use crate::app_config::{self, AppConfig};
use crate::error::{AppError, AppResult};
use crate::git_remote::{self, RemoteOpManager, RemoteProgress};
use crate::git_service;
use crate::graph;
use crate::logger;
use crate::recent_repos;
use crate::repo_manager::{RepoManager, lock_entry};
use crate::types::{
    BranchInfo, ChangedFile, CommitMetadata, CommitSignatureInfo, ConflictFileDetail,
    DiffLineSelection, DiffPatchAction, DiffScope, DiffScopeKind, FetchResult, FileBlameResult,
    FileDiffResult, FileHistoryEntry, FileStatus, GitActionResult, GitProgressEvent, GraphPage,
    LogFilter, OpenRepositoryOutcome, PullResult, PushResult, RebaseCommitEntry, RebasePlanEntry,
    RecentRepo, RepoInfo, StashEntry,
};
use crate::watcher::RepoWatcher;

/// 远程操作实时进度事件名。
const GIT_REMOTE_PROGRESS_EVENT: &str = "git_remote_progress";

/// 提交图默认分页大小（调用方未显式传 limit 时）。
const DEFAULT_GRAPH_PAGE_SIZE: usize = 200;

/// `get_app_config` 返回载荷：设置本体 + 是否首次运行（尚未持久化过设置）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigPayload {
    pub config: AppConfig,
    pub fresh: bool,
}

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
fn parse_graph_cursor(raw: &str) -> Option<(u64, &str)> {
    let (gen_str, oid) = raw.split_once(':')?;
    let generation = gen_str.parse::<u64>().ok()?;
    Some((generation, oid))
}

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
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GraphPage> {
        let mut entry = lock_entry(&entry);
        let raw_cursor = match cursor.as_deref() {
            None => None,
            Some(c) => {
                if let Some((generation, oid)) = parse_graph_cursor(c) {
                    if generation != entry.graph_generation {
                        return Err(AppError::InvalidArg(
                            "提交图分页会话已过期，请刷新提交列表".to_string(),
                        ));
                    }
                    Some(oid.to_string())
                } else {
                    Some(c.to_string())
                }
            }
        };
        let (commits, has_more) = git_service::load_commit_page(
            &entry.repo,
            raw_cursor.as_deref(),
            limit,
            filter.as_ref(),
        )?;
        if cursor.is_none() {
            entry.graph_state = graph::GraphState::new();
            entry.graph_generation = entry.graph_generation.wrapping_add(1);
        }
        let generation = entry.graph_generation;
        let rows = entry.graph_state.compute_graph_rows(commits);
        let next_cursor = if has_more {
            rows.last()
                .map(|row| format!("{generation}:{}", row.commit.id))
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

/// 两个提交或引用之间的变更文件列表（`baseRef` → `targetRef`）。
#[tauri::command]
pub async fn get_range_files(
    state: State<'_, RepoManager>,
    repo_id: String,
    base_ref: String,
    target_ref: String,
) -> AppResult<Vec<ChangedFile>> {
    if base_ref.trim().is_empty() || target_ref.trim().is_empty() {
        return Err(AppError::InvalidArg(
            "baseRef 与 targetRef 均不能为空".to_string(),
        ));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<ChangedFile>> {
        let entry = lock_entry(&entry);
        git_service::changed_files_range(&entry.repo, &base_ref, &target_ref)
    })
    .await
    .map_err(join_error)?
}

/// 按 `scope`（提交 / 范围对比 / 暂存区 / 工作区）计算单个文件的左右分栏 diff。
/// `ignore_whitespace`：比较时忽略空白差异（与局部补丁应用共用同一选项，
/// 保证选区行下标在视图与应用两侧一致）。
#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, RepoManager>,
    repo_id: String,
    scope: DiffScope,
    path: String,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiffResult> {
    git_service::validate_rel_path(&path)?;
    // commit / range 范围必须提供对应引用（提前校验，避免后台任务白跑）。
    if matches!(scope.kind, DiffScopeKind::Commit)
        && scope.commit_id.as_deref().is_none_or(str::is_empty)
    {
        return Err(AppError::InvalidArg(
            "scope.kind 为 commit 时必须提供 commitId".to_string(),
        ));
    }
    if matches!(scope.kind, DiffScopeKind::Range)
        && (scope
            .base_ref
            .as_deref()
            .is_none_or(|s| s.trim().is_empty())
            || scope
                .target_ref
                .as_deref()
                .is_none_or(|s| s.trim().is_empty()))
    {
        return Err(AppError::InvalidArg(
            "scope.kind 为 range 时必须提供 baseRef 与 targetRef".to_string(),
        ));
    }
    if matches!(scope.kind, DiffScopeKind::Stash) && scope.stash_index.is_none() {
        return Err(AppError::InvalidArg(
            "scope.kind 为 stash 时必须提供 stashIndex".to_string(),
        ));
    }
    let ignore_ws = ignore_whitespace.unwrap_or(false);
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<FileDiffResult> {
        let entry = lock_entry(&entry);
        match scope.kind {
            DiffScopeKind::Commit => git_service::file_diff_commit(
                &entry.repo,
                scope.commit_id.as_deref().unwrap_or_default(),
                &path,
                ignore_ws,
            ),
            DiffScopeKind::Range => git_service::file_diff_range(
                &entry.repo,
                scope.base_ref.as_deref().unwrap_or_default(),
                scope.target_ref.as_deref().unwrap_or_default(),
                &path,
                ignore_ws,
            ),
            DiffScopeKind::Staged => git_service::file_diff_staged(&entry.repo, &path, ignore_ws),
            DiffScopeKind::Workdir => git_service::file_diff_workdir(&entry.repo, &path, ignore_ws),
            DiffScopeKind::Stash => git_service::file_diff_stash(
                &entry.repo,
                scope.stash_index.unwrap_or(0),
                &path,
                ignore_ws,
            ),
        }
    })
    .await
    .map_err(join_error)?
}

/// 对工作区或暂存区 diff 应用 hunk / 行级局部暂存、取消暂存或丢弃。
#[tauri::command]
pub async fn apply_diff_selection(
    state: State<'_, RepoManager>,
    repo_id: String,
    scope: DiffScope,
    path: String,
    action: DiffPatchAction,
    selections: Vec<DiffLineSelection>,
    ignore_whitespace: Option<bool>,
) -> AppResult<()> {
    git_service::validate_rel_path(&path)?;
    if selections.is_empty() {
        return Err(AppError::InvalidArg("选区不能为空".to_string()));
    }
    let ignore_ws = ignore_whitespace.unwrap_or(false);
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let mut entry = lock_entry(&entry);
        git_service::apply_diff_selection(
            &mut entry.repo,
            &scope,
            &path,
            action,
            &selections,
            ignore_ws,
        )
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
    git_service::validate_rel_path(&path)?;
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
    git_service::validate_rel_path(&path)?;
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let mut entry = lock_entry(&entry);
        git_service::unstage_file(&mut entry.repo, &path)
    })
    .await
    .map_err(join_error)?
}

/// 提交当前暂存区，返回新提交 id（可选强制开启或跳过 GPG / SSH 签名）。
#[tauri::command]
pub async fn create_commit(
    state: State<'_, RepoManager>,
    repo_id: String,
    message: String,
    sign: Option<bool>,
) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::InvalidArg("提交信息不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<String> {
        let mut entry = lock_entry(&entry);
        git_service::create_commit_with_options(&mut entry.repo, &message, sign)
    })
    .await
    .map_err(join_error)?
}

/// 读取提交模板与仓库 GPG/SSH 签名配置元数据。
#[tauri::command]
pub async fn get_commit_metadata(
    state: State<'_, RepoManager>,
    repo_id: String,
) -> AppResult<CommitMetadata> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<CommitMetadata> {
        let entry = lock_entry(&entry);
        git_service::commit_metadata(&entry.repo)
    })
    .await
    .map_err(join_error)?
}

/// 校验指定提交的 GPG / SSH 签名状态。
#[tauri::command]
pub async fn get_commit_signature(
    state: State<'_, RepoManager>,
    repo_id: String,
    commit_id: String,
) -> AppResult<CommitSignatureInfo> {
    if commit_id.trim().is_empty() {
        return Err(AppError::InvalidArg("commitId 不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<CommitSignatureInfo> {
        let entry = lock_entry(&entry);
        git_service::commit_signature_info(&entry.repo, &commit_id)
    })
    .await
    .map_err(join_error)?
}

/// 读取从 HEAD 起最近连续的非合并提交列表（供轻量交互式 rebase 展示）。
#[tauri::command]
pub async fn list_rebase_commits(
    state: State<'_, RepoManager>,
    repo_id: String,
    limit: Option<usize>,
) -> AppResult<Vec<RebaseCommitEntry>> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<RebaseCommitEntry>> {
        let entry = lock_entry(&entry);
        git_service::list_rebase_commits(&entry.repo, limit.unwrap_or(20))
    })
    .await
    .map_err(join_error)?
}

/// 执行轻量交互式 rebase（Pick / Reword / Squash / Fixup 最近 N 个提交）。
#[tauri::command]
pub async fn rewrite_recent_commits(
    state: State<'_, RepoManager>,
    repo_id: String,
    plan: Vec<RebasePlanEntry>,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let mut entry = lock_entry(&entry);
        let new_head = git_service::rewrite_recent_commits(&mut entry.repo, &plan)?;
        let repo = git_service::repo_info(&entry.repo)?;
        Ok(GitActionResult {
            output: new_head,
            repo,
        })
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
        let res = task(&entry.repo, &workdir, progress);
        if let Err(ref e) = res {
            logger::log_backend_error(&app, op_kind, e);
        }
        res
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

/// 记录前端上报的错误/告警日志到本地日志文件。
#[tauri::command]
pub async fn log_client_error(
    app: tauri::AppHandle,
    level: String,
    source: String,
    message: String,
) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let file = logger::log_file(&app)?;
        logger::append_log(&file, &level, &source, &message)
    })
    .await
    .map_err(join_error)?
}

/// 获取本地日志文件的绝对路径（便于用户排查或定位日志）。
#[tauri::command]
pub async fn get_log_file_path(app: tauri::AppHandle) -> AppResult<String> {
    let file = logger::log_file(&app)?;
    Ok(file.to_string_lossy().into_owned())
}

/// 读取冲突文件的三方（Base / Ours / Theirs）与当前工作区快照。
#[tauri::command]
pub async fn get_conflict_file(
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
) -> AppResult<ConflictFileDetail> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidArg("path 不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<ConflictFileDetail> {
        let entry = lock_entry(&entry);
        git_service::get_conflict_file(&entry.repo, &path)
    })
    .await
    .map_err(join_error)?
}

/// 写入冲突解决结果并按需暂存（标记已解决）。
#[tauri::command]
pub async fn resolve_conflict_file(
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
    content: String,
    stage: bool,
    delete_file: Option<bool>,
) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidArg("path 不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let mut entry = lock_entry(&entry);
        git_service::resolve_conflict_file(
            &mut entry.repo,
            &path,
            &content,
            stage,
            delete_file.unwrap_or(false),
        )
    })
    .await
    .map_err(join_error)?
}

/// 计算指定文件在给定提交或工作区下的逐行 Blame。
#[tauri::command]
pub async fn get_file_blame(
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
    commit_id: Option<String>,
) -> AppResult<FileBlameResult> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidArg("path 不能为空".to_string()));
    }
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<FileBlameResult> {
        let entry = lock_entry(&entry);
        git_service::file_blame(&entry.repo, &path, commit_id.as_deref())
    })
    .await
    .map_err(join_error)?
}

/// 读取应用设置（文件缺失或损坏时返回默认值；fresh 标记首次运行供前端迁移旧偏好）。
#[tauri::command]
pub async fn get_app_config(app: tauri::AppHandle) -> AppResult<AppConfigPayload> {
    tauri::async_runtime::spawn_blocking(move || -> AppResult<AppConfigPayload> {
        let file = app_config::app_config_file(&app)?;
        let (config, fresh) = app_config::load_app_config(&file)?;
        Ok(AppConfigPayload { config, fresh })
    })
    .await
    .map_err(join_error)?
}

/// 保存应用设置：规整取值后原子写入，并即时应用 git 可执行路径覆盖；
/// 返回落盘后的最终配置（供前端回显规整结果）。
#[tauri::command]
pub async fn set_app_config(
    app: tauri::AppHandle,
    config: AppConfig,
) -> AppResult<AppConfig> {
    tauri::async_runtime::spawn_blocking(move || -> AppResult<AppConfig> {
        let config = config.normalized();
        let file = app_config::app_config_file(&app)?;
        app_config::save_app_config(&file, &config)?;
        git_remote::set_git_bin_override(config.git_executable_path.as_deref());
        Ok(config)
    })
    .await
    .map_err(join_error)?
}

/// 在 Finder 中定位仓库内文件（右键菜单 / docs/11 §三 6.7）。
#[tauri::command]
pub async fn reveal_path_in_finder(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let entry = lock_entry(&entry);
        let workdir = entry
            .repo
            .workdir()
            .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
        let abs = crate::git_service::resolve_workdir_path(workdir, &path)?;
        app.opener()
            .reveal_item_in_dir(abs)
            .map_err(|e| AppError::Io(format!("在 Finder 中定位失败: {e}")))
    })
    .await
    .map_err(join_error)?
}

/// 用设置中配置的外部编辑器打开文件（可选跳转到行号）。
#[tauri::command]
pub async fn open_file_in_editor(
    app: tauri::AppHandle,
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
    line: Option<u32>,
) -> AppResult<()> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let file = app_config::app_config_file(&app)?;
        let (config, _) = app_config::load_app_config(&file)?;
        let template = config.external_editor_command.ok_or_else(|| {
            AppError::InvalidArg("尚未配置外部编辑器命令，请先在设置中填写".to_string())
        })?;
        let entry = lock_entry(&entry);
        let workdir = entry
            .repo
            .workdir()
            .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
        let abs = crate::git_service::resolve_workdir_path(workdir, &path)?;
        let args = crate::external::build_editor_args(&template, &abs.to_string_lossy(), line)?;
        crate::external::spawn_detached(&args, workdir)
    })
    .await
    .map_err(join_error)?
}

/// 生成工作区 / 暂存区单文件的 unified patch 文本（复制补丁用）。
#[tauri::command]
pub async fn generate_file_patch(
    state: State<'_, RepoManager>,
    repo_id: String,
    scope: DiffScope,
    path: String,
) -> AppResult<String> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<String> {
        let entry = lock_entry(&entry);
        git_service::generate_file_patch(&entry.repo, &scope, &path)
    })
    .await
    .map_err(join_error)?
}

/// 弹出原生文件选择框选取 git 可执行文件（设置页 Git 路径旁的浏览按钮）；
/// 用户取消返回 None。
#[tauri::command]
pub async fn pick_git_executable(app: tauri::AppHandle) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Option<String>> {
        Ok(app
            .dialog()
            .file()
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(join_error)?
}

/// 读取单个文件的提交历史（`--follow` 跨重命名追踪，v0.7 / 7.1）。
#[tauri::command]
pub async fn get_file_history(
    state: State<'_, RepoManager>,
    repo_id: String,
    path: String,
    limit: Option<usize>,
) -> AppResult<Vec<FileHistoryEntry>> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<FileHistoryEntry>> {
        let entry = lock_entry(&entry);
        git_service::file_history(&entry.repo, &path, limit.unwrap_or(500))
    })
    .await
    .map_err(join_error)?
}

/// 列出贮藏条目的变更文件（stash 提交 vs 基准父提交，v0.7 / 7.4）。
#[tauri::command]
pub async fn get_stash_files(
    state: State<'_, RepoManager>,
    repo_id: String,
    index: u32,
) -> AppResult<Vec<ChangedFile>> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<ChangedFile>> {
        let entry = lock_entry(&entry);
        git_service::changed_files_stash(&entry.repo, index)
    })
    .await
    .map_err(join_error)?
}

/// 列出包含指定提交的分支（v0.7 / 7.5）。
#[tauri::command]
pub async fn list_branches_containing(
    state: State<'_, RepoManager>,
    repo_id: String,
    commit_id: String,
) -> AppResult<Vec<String>> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<String>> {
        let entry = lock_entry(&entry);
        git_service::branches_containing(&entry.repo, &commit_id)
    })
    .await
    .map_err(join_error)?
}

/// 基于贮藏条目创建并切换分支（建分支 + 检出 + 应用，成功后弹出，v0.7 / 7.4）。
#[tauri::command]
pub async fn stash_branch(
    state: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    index: usize,
) -> AppResult<GitActionResult> {
    let entry = state.inner().clone().entry(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<GitActionResult> {
        let entry = lock_entry(&entry);
        let workdir = workdir_of(&entry.repo)?;
        git_remote::stash_branch(&entry.repo, &workdir, &name, index)
    })
    .await
    .map_err(join_error)?
}
