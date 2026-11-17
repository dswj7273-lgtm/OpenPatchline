//! Git Service：封装所有 git2-rs 本地仓库操作的高层 API（docs/04-git-engine.md）。
//!
//! 按职责拆分为子模块并统一在此重导出，保持外部调用契约稳定：
//! - [`history`]：分页提交遍历与过滤器；
//! - [`diff`]：提交 / 范围 / 暂存区 / 工作区文件差异计算；
//! - [`patch`]：Hunk 与行级局部暂存 / 取消暂存 / 丢弃；
//! - [`status`]：工作区状态、stage / unstage；
//! - [`commit`]：创建提交、模板与签名元数据、状态收尾；
//! - [`branch`]：分支列表、检出与远程跟踪分支；
//! - [`rebase`]：轻量交互式变基（squash / fixup / reword 最近提交）；
//! - [`conflict`]：三方合并冲突详情读取与解决写入；
//! - [`blame`]：逐行 Blame 归属查询。

mod blame;
mod branch;
mod commit;
mod conflict;
mod diff;
mod history;
mod patch;
mod rebase;
mod status;

#[cfg(test)]
mod tests;

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::types::{ChangeType, ChildRepo, RepoInfo, RepoState};

pub use blame::file_blame;
pub use branch::{checkout_branch, list_branches};
pub use commit::{
    commit_metadata, commit_signature_info, create_commit, create_commit_with_options,
};
pub use conflict::{get_conflict_file, resolve_conflict_file};
pub use diff::{
    changed_files, changed_files_range, file_diff_commit, file_diff_range, file_diff_staged,
    file_diff_workdir,
};
pub use history::load_commit_page;
pub use patch::apply_diff_selection;
pub use rebase::{list_rebase_commits, rewrite_recent_commits};
pub use status::{stage_file, status, unstage_file};

/// 扫描目录的直接子目录，返回其中的 Git 仓库（按名称排序）。
///
/// 用于「所选目录不是仓库」的场景（如工作区目录）：前端据此展示候选
/// 仓库列表。只查一层、只认 `<child>/.git` 的存在性，不做深度遍历。
pub fn list_child_repos(dir: &Path) -> Vec<ChildRepo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut repos: Vec<ChildRepo> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| e.path().join(".git").exists())
        .map(|e| ChildRepo {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
        })
        .collect();
    repos.sort_by(|a, b| a.name.cmp(&b.name));
    repos
}

/// 读取仓库当前进行中的操作状态（Clean / Merging / Rebasing / CherryPicking / Reverting 等）。
pub fn repo_state(repo: &git2::Repository) -> RepoState {
    match repo.state() {
        git2::RepositoryState::Clean => RepoState::Clean,
        git2::RepositoryState::Merge => RepoState::Merging,
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => RepoState::Rebasing,
        git2::RepositoryState::CherryPick | git2::RepositoryState::CherryPickSequence => {
            RepoState::CherryPicking
        }
        git2::RepositoryState::Revert | git2::RepositoryState::RevertSequence => {
            RepoState::Reverting
        }
        git2::RepositoryState::Bisect => RepoState::Bisecting,
        git2::RepositoryState::ApplyMailbox => RepoState::Applying,
        git2::RepositoryState::ApplyMailboxOrRebase => {
            if repo.path().join("rebase-apply/rebasing").exists() {
                RepoState::Rebasing
            } else {
                RepoState::Applying
            }
        }
    }
}

/// 读取仓库基本信息（见 [`RepoInfo`] 字段说明）。
///
/// `id` 取 workdir 根路径 canonicalize 后的绝对路径；空仓库 `head_commit`
/// 为空字符串、`head_branch` 为 None（分离 HEAD 时同样 `head_branch` 为 None）。
pub fn repo_info(repo: &git2::Repository) -> AppResult<RepoInfo> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
    let path = workdir.to_string_lossy().trim_end_matches('/').to_string();
    let canonical = std::fs::canonicalize(workdir)
        .map_err(|e| AppError::Io(format!("解析仓库路径 {path} 失败: {e}")))?;
    let id = canonical.to_string_lossy().into_owned();
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    let (head_branch, head_commit) = match repo.head() {
        Ok(head) => {
            let branch = if head.is_branch() {
                head.shorthand().ok().map(str::to_string)
            } else {
                None
            };
            let commit = head
                .peel_to_commit()
                .map_err(|e| AppError::Git(format!("解析 HEAD 提交失败: {e}")))?
                .id()
                .to_string();
            (branch, commit)
        }
        Err(e)
            if matches!(
                e.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            (None, String::new())
        }
        Err(e) => return Err(AppError::Git(format!("读取 HEAD 失败: {e}"))),
    };

    Ok(RepoInfo {
        id,
        path,
        name,
        head_branch,
        head_commit,
        state: repo_state(repo),
    })
}

/// 按 id 查找提交；id 非法报 InvalidArg，不存在报 NotFound。
pub(super) fn find_commit<'r>(
    repo: &'r git2::Repository,
    commit_id: &str,
) -> AppResult<git2::Commit<'r>> {
    let oid = git2::Oid::from_str(commit_id)
        .map_err(|e| AppError::InvalidArg(format!("commit id 非法: {commit_id} ({e})")))?;
    repo.find_commit(oid)
        .map_err(|e| AppError::NotFound(format!("提交不存在: {commit_id} ({e})")))
}

/// HEAD 提交；空仓库（unborn HEAD）返回 None。
pub(super) fn head_commit(repo: &git2::Repository) -> AppResult<Option<git2::Commit<'_>>> {
    match repo.head() {
        Ok(head) => {
            let commit = head
                .peel_to_commit()
                .map_err(|e| AppError::Git(format!("解析 HEAD 提交失败: {e}")))?;
            Ok(Some(commit))
        }
        Err(e)
            if matches!(
                e.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            Ok(None)
        }
        Err(e) => Err(AppError::Git(format!("读取 HEAD 失败: {e}"))),
    }
}

/// HEAD 提交的树；空仓库（unborn HEAD）返回 None（等价于空树）。
pub(super) fn head_tree(repo: &git2::Repository) -> AppResult<Option<git2::Tree<'_>>> {
    match head_commit(repo)? {
        Some(commit) => {
            let tree = commit
                .tree()
                .map_err(|e| AppError::Git(format!("读取 HEAD 树失败: {e}")))?;
            Ok(Some(tree))
        }
        None => Ok(None),
    }
}

/// 读取并同步磁盘最新 `.git/index`（避免外部 CLI 操作后 libgit2 返回缓存的旧索引）。
pub(crate) fn fresh_index(repo: &git2::Repository) -> AppResult<git2::Index> {
    let mut index = repo
        .index()
        .map_err(|e| AppError::Git(format!("读取 index 失败: {e}")))?;
    index
        .read(false)
        .map_err(|e| AppError::Git(format!("刷新 index 失败: {e}")))?;
    Ok(index)
}

/// `git2::Delta` → `ChangeType`；无法归类（Unmodified/Ignored 等）返回 None。
pub(super) fn delta_change_type(status: git2::Delta) -> Option<ChangeType> {
    match status {
        git2::Delta::Added => Some(ChangeType::Added),
        git2::Delta::Deleted => Some(ChangeType::Deleted),
        git2::Delta::Renamed | git2::Delta::Copied => Some(ChangeType::Renamed),
        git2::Delta::Modified | git2::Delta::Typechange => Some(ChangeType::Modified),
        git2::Delta::Untracked => Some(ChangeType::Untracked),
        _ => None,
    }
}

/// 校验仓库内相对路径合法性（非空、含有效路径段、无 NUL/绝对路径/`..`/盘符）。
pub(crate) fn validate_rel_path(path: &str) -> AppResult<&Path> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::InvalidArg(
            "path 不能为空且不能包含空字节".to_string(),
        ));
    }
    let rel = Path::new(path);
    if rel.is_absolute()
        || rel.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
        || !rel.components().any(|c| matches!(c, Component::Normal(_)))
    {
        return Err(AppError::InvalidArg(format!("非法相对路径: {path}")));
    }
    Ok(rel)
}

/// 将仓库相对路径解析为规范化工作区根下的绝对路径，拦截父目录符号链接逃逸。
pub(crate) fn resolve_workdir_path(workdir: &Path, path: &str) -> AppResult<PathBuf> {
    let rel = validate_rel_path(path)?;
    let canon_root = std::fs::canonicalize(workdir)
        .map_err(|e| AppError::Io(format!("解析工作区根目录失败: {e}")))?;

    let segments: Vec<_> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(seg) => Some(seg),
            _ => None,
        })
        .collect();

    let mut cur = canon_root.clone();
    for (idx, seg) in segments.iter().enumerate() {
        cur.push(seg);
        let is_last = idx + 1 == segments.len();
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) => {
                if !is_last && meta.file_type().is_symlink() {
                    let resolved = std::fs::canonicalize(&cur).map_err(|_| {
                        AppError::InvalidArg(format!("路径包含悬空或越界符号链接: {path}"))
                    })?;
                    if !resolved.starts_with(&canon_root) {
                        return Err(AppError::InvalidArg(format!(
                            "路径超出仓库工作区范围: {path}"
                        )));
                    }
                    cur = resolved;
                } else if is_last && !meta.file_type().is_symlink() {
                    let resolved = std::fs::canonicalize(&cur)
                        .map_err(|e| AppError::Io(format!("解析工作区路径 {path} 失败: {e}")))?;
                    if !resolved.starts_with(&canon_root) {
                        return Err(AppError::InvalidArg(format!(
                            "路径超出仓库工作区范围: {path}"
                        )));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(AppError::Io(format!("检查工作区路径 {path} 失败: {e}"))),
        }
    }
    Ok(canon_root.join(rel))
}

/// 安全读取工作区文件字节：校验仓库边界，对符号链接仅读取其链接目标文本而不解引用外部目标。
pub(super) fn read_workdir_file(workdir: &Path, path: &str) -> AppResult<Option<Vec<u8>>> {
    let full = resolve_workdir_path(workdir, path)?;
    match std::fs::symlink_metadata(&full) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                let target = std::fs::read_link(&full)
                    .map_err(|e| AppError::Io(format!("读取符号链接 {path} 失败: {e}")))?;
                return Ok(Some(target.to_string_lossy().into_owned().into_bytes()));
            }
            if meta.is_dir() {
                return Ok(None);
            }
            std::fs::read(&full)
                .map(Some)
                .map_err(|e| AppError::Io(format!("读取工作区文件 {path} 失败: {e}")))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(format!("读取工作区文件 {path} 失败: {e}"))),
    }
}

/// `&Path` → 展示用字符串。
pub(super) fn path_str(p: Option<&Path>) -> Option<String> {
    p.map(|p| p.to_string_lossy().into_owned())
}
