//! 提交 / 暂存区 / 工作区文件差异计算子模块。

use std::path::Path;

use super::{
    delta_change_type, find_commit, fresh_index, head_tree, path_str, read_workdir_file,
    resolve_workdir_path, validate_rel_path,
};
use crate::diff_engine::{self, DiffOptions as TextDiffOptions};
use crate::error::{AppError, AppResult};
use crate::types::{ChangeType, ChangedFile, FileDiffResult};

/// 二进制内容嗅探窗口（字节）：前 8KB 出现 NUL 即视为二进制。
const BINARY_SNIFF_LEN: usize = 8192;
/// 单文件 diff 大小保护阈值：old + new 总字节数超过则置 `too_large`。
const MAX_DIFF_BYTES: usize = 10 * 1024 * 1024;
/// 单文件 diff 行数保护阈值：old + new 总行数超过则置 `too_large`。
const MAX_DIFF_LINES: usize = 100_000;
/// find_similar 的重命名/复制相似度阈值（百分比）。
const SIMILARITY_THRESHOLD: u16 = 50;

/// 某次提交相对其第一个父提交的变更文件列表。
pub fn changed_files(repo: &git2::Repository, commit_id: &str) -> AppResult<Vec<ChangedFile>> {
    let commit = find_commit(repo, commit_id)?;
    let new_tree = commit
        .tree()
        .map_err(|e| AppError::Git(format!("读取提交树失败: {e}")))?;
    let parent_tree = first_parent_tree(&commit)?;
    changed_files_between_trees(
        repo,
        parent_tree.as_ref(),
        Some(&new_tree),
        &format!("提交 {commit_id}"),
    )
}

/// 两个提交或引用之间的变更文件列表（`base_ref` → `target_ref`）。
pub fn changed_files_range(
    repo: &git2::Repository,
    base_ref: &str,
    target_ref: &str,
) -> AppResult<Vec<ChangedFile>> {
    let base_tree = resolve_tree(repo, base_ref)?;
    let target_tree = resolve_tree(repo, target_ref)?;
    changed_files_between_trees(
        repo,
        Some(&base_tree),
        Some(&target_tree),
        &format!("{base_ref}..{target_ref}"),
    )
}

fn changed_files_between_trees(
    repo: &git2::Repository,
    old_tree: Option<&git2::Tree<'_>>,
    new_tree: Option<&git2::Tree<'_>>,
    label: &str,
) -> AppResult<Vec<ChangedFile>> {
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0);
    let mut diff = repo
        .diff_tree_to_tree(old_tree, new_tree, Some(&mut opts))
        .map_err(|e| AppError::Git(format!("计算 {label} 的 diff 失败: {e}")))?;
    find_similar(&mut diff)?;

    let mut files = Vec::with_capacity(diff.deltas().len());
    for (idx, delta) in diff.deltas().enumerate() {
        let new_path = path_str(delta.new_file().path());
        let old_path = path_str(delta.old_file().path());
        let path = new_path
            .clone()
            .or(old_path.clone())
            .ok_or_else(|| AppError::InvalidArg("diff delta 缺少路径".to_string()))?;

        let binary = delta.flags().contains(git2::DiffFlags::BINARY)
            || is_binary_blob(repo, delta.old_file().id())
            || is_binary_blob(repo, delta.new_file().id());
        if binary {
            files.push(ChangedFile {
                path,
                old_path: None,
                change_type: ChangeType::Binary,
                additions: 0,
                deletions: 0,
            });
            continue;
        }

        let change_type = delta_change_type(delta.status()).unwrap_or(ChangeType::Modified);
        let renamed = matches!(change_type, ChangeType::Renamed);
        let (additions, deletions) = match git2::Patch::from_diff(&diff, idx) {
            Ok(Some(patch)) => patch
                .line_stats()
                .map(|(_, a, d)| (a as u32, d as u32))
                .unwrap_or((0, 0)),
            _ => (0, 0),
        };
        files.push(ChangedFile {
            path,
            old_path: if renamed { old_path } else { None },
            change_type,
            additions,
            deletions,
        });
    }
    Ok(files)
}

/// 某次提交中单个文件的左右分栏 diff（commit vs 第一个父提交）。
pub fn file_diff_commit(
    repo: &git2::Repository,
    commit_id: &str,
    path: &str,
) -> AppResult<FileDiffResult> {
    validate_rel_path(path)?;
    let commit = find_commit(repo, commit_id)?;
    let new_tree = commit
        .tree()
        .map_err(|e| AppError::Git(format!("读取提交树失败: {e}")))?;
    let parent_tree = first_parent_tree(&commit)?;
    file_diff_between_trees(repo, parent_tree.as_ref(), Some(&new_tree), path, "该提交")
}

/// 两个提交或引用之间单个文件的左右分栏 diff（`base_ref` → `target_ref`）。
pub fn file_diff_range(
    repo: &git2::Repository,
    base_ref: &str,
    target_ref: &str,
    path: &str,
) -> AppResult<FileDiffResult> {
    validate_rel_path(path)?;
    let base_tree = resolve_tree(repo, base_ref)?;
    let target_tree = resolve_tree(repo, target_ref)?;
    file_diff_between_trees(
        repo,
        Some(&base_tree),
        Some(&target_tree),
        path,
        &format!("{base_ref}..{target_ref}"),
    )
}

fn file_diff_between_trees(
    repo: &git2::Repository,
    old_tree: Option<&git2::Tree<'_>>,
    new_tree: Option<&git2::Tree<'_>>,
    path: &str,
    scope_label: &str,
) -> AppResult<FileDiffResult> {
    let (status, old_path, new_path) =
        tree_delta_info(repo, old_tree, new_tree, path, scope_label)?;
    let old = if status == git2::Delta::Added {
        None
    } else {
        blob_bytes_from_tree(repo, old_tree, old_path.as_deref().unwrap_or(path))?
    };
    let new = if status == git2::Delta::Deleted {
        None
    } else {
        blob_bytes_from_tree(repo, new_tree, new_path.as_deref().unwrap_or(path))?
    };
    let change_type = delta_change_type(status).unwrap_or(ChangeType::Modified);
    Ok(build_file_diff(old, new, old_path, new_path, change_type))
}

/// 暂存区中单个文件的 diff：HEAD blob vs index blob。
pub fn file_diff_staged(repo: &git2::Repository, path: &str) -> AppResult<FileDiffResult> {
    validate_rel_path(path)?;
    let head_tree = head_tree(repo)?;
    let index = fresh_index(repo)?;

    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0);
    let mut diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))
        .map_err(|e| AppError::Git(format!("计算 {path} 的暂存 diff 失败: {e}")))?;
    find_similar(&mut diff)?;
    let delta = find_delta(diff.deltas(), path, false)
        .ok_or_else(|| AppError::NotFound(format!("文件 {path} 暂存区无变更")))?;
    let status = delta.status();
    let old_path = path_str(delta.old_file().path());
    let new_path = path_str(delta.new_file().path());

    let old = if status == git2::Delta::Added {
        None
    } else {
        blob_bytes_from_tree(
            repo,
            head_tree.as_ref(),
            old_path.as_deref().unwrap_or(path),
        )?
    };
    let new = if status == git2::Delta::Deleted {
        None
    } else {
        blob_bytes_from_index(repo, &index, new_path.as_deref().unwrap_or(path))?
    };
    let change_type = delta_change_type(status).unwrap_or(ChangeType::Modified);
    Ok(build_file_diff(old, new, old_path, new_path, change_type))
}

/// 工作区中单个文件的 diff：index blob（不在 index 则取 HEAD）vs 工作区文件字节。
pub fn file_diff_workdir(repo: &git2::Repository, path: &str) -> AppResult<FileDiffResult> {
    let rel = validate_rel_path(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
    let _ = resolve_workdir_path(workdir, path)?;
    let index = fresh_index(repo)?;
    let head_tree = head_tree(repo)?;

    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0).include_untracked(true);
    let mut diff = repo
        .diff_index_to_workdir(Some(&index), Some(&mut opts))
        .map_err(|e| AppError::Git(format!("计算 {path} 的工作区 diff 失败: {e}")))?;
    find_similar(&mut diff)?;
    let (status, old_path, new_path) = match find_delta(diff.deltas(), path, false) {
        Some(delta) => (
            Some(delta.status()),
            path_str(delta.old_file().path()),
            path_str(delta.new_file().path()),
        ),
        None => {
            let tracked = index.get_path(rel, 0).is_some()
                || head_tree.as_ref().is_some_and(|t| t.get_path(rel).is_ok());
            if !tracked {
                return Err(AppError::NotFound(format!("文件 {path} 在工作区无变更")));
            }
            (None, Some(path.to_string()), Some(path.to_string()))
        }
    };

    let old_lookup = old_path.as_deref().unwrap_or(path);
    let old = match blob_bytes_from_index(repo, &index, old_lookup)? {
        Some(bytes) => Some(bytes),
        None => blob_bytes_from_tree(repo, head_tree.as_ref(), old_lookup)?,
    };
    let new_lookup = new_path.as_deref().unwrap_or(path);
    let new = if status == Some(git2::Delta::Deleted) {
        None
    } else {
        read_workdir_file(workdir, new_lookup)?
    };

    let change_type = match status.and_then(delta_change_type) {
        Some(ChangeType::Untracked) if old.is_none() => ChangeType::Added,
        Some(
            t @ (ChangeType::Renamed
            | ChangeType::Modified
            | ChangeType::Added
            | ChangeType::Deleted),
        ) => t,
        _ => match (&old, &new) {
            (None, Some(_)) => ChangeType::Added,
            (Some(_), None) => ChangeType::Deleted,
            _ => ChangeType::Modified,
        },
    };
    Ok(build_file_diff(old, new, old_path, new_path, change_type))
}

fn first_parent_tree<'r>(commit: &git2::Commit<'r>) -> AppResult<Option<git2::Tree<'r>>> {
    if commit.parent_count() == 0 {
        return Ok(None);
    }
    let parent = commit
        .parent(0)
        .map_err(|e| AppError::Git(format!("读取父提交失败: {e}")))?;
    let tree = parent
        .tree()
        .map_err(|e| AppError::Git(format!("读取父提交树失败: {e}")))?;
    Ok(Some(tree))
}

fn resolve_tree<'r>(repo: &'r git2::Repository, rev: &str) -> AppResult<git2::Tree<'r>> {
    let trimmed = rev.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidArg(
            "对比引用或提交 id 不能为空".to_string(),
        ));
    }
    let obj = repo
        .revparse_single(trimmed)
        .map_err(|e| AppError::NotFound(format!("无法解析引用或提交 {trimmed}: {e}")))?;
    obj.peel_to_tree()
        .map_err(|e| AppError::NotFound(format!("引用 {trimmed} 未指向有效的提交树: {e}")))
}

fn tree_delta_info(
    repo: &git2::Repository,
    old_tree: Option<&git2::Tree<'_>>,
    new_tree: Option<&git2::Tree<'_>>,
    path: &str,
    scope_label: &str,
) -> AppResult<(git2::Delta, Option<String>, Option<String>)> {
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0);
    let mut diff = repo
        .diff_tree_to_tree(old_tree, new_tree, Some(&mut opts))
        .map_err(|e| AppError::Git(format!("计算 {path} 的 diff 失败: {e}")))?;
    find_similar(&mut diff)?;
    let delta = find_delta(diff.deltas(), path, true)
        .ok_or_else(|| AppError::NotFound(format!("文件 {path} 在{scope_label}中无变更")))?;
    Ok((
        delta.status(),
        path_str(delta.old_file().path()),
        path_str(delta.new_file().path()),
    ))
}

pub(super) fn find_delta<'d>(
    deltas: git2::Deltas<'d>,
    path: &str,
    prefer_new: bool,
) -> Option<git2::DiffDelta<'d>> {
    let wanted = Path::new(path);
    let hit = |p: Option<&Path>| p == Some(wanted);
    let mut other_side = None;
    for delta in deltas {
        let (old, new) = (delta.old_file().path(), delta.new_file().path());
        if hit(if prefer_new { new } else { old }) {
            return Some(delta);
        }
        if other_side.is_none() && hit(if prefer_new { old } else { new }) {
            other_side = Some(delta);
        }
    }
    other_side
}

pub(super) fn find_similar(diff: &mut git2::Diff<'_>) -> AppResult<()> {
    let mut opts = git2::DiffFindOptions::new();
    opts.renames(true)
        .copies(true)
        .for_untracked(true)
        .rename_threshold(SIMILARITY_THRESHOLD);
    diff.find_similar(Some(&mut opts))
        .map_err(|e| AppError::Git(format!("重命名检测失败: {e}")))
}

pub(super) fn blob_bytes_from_tree(
    repo: &git2::Repository,
    tree: Option<&git2::Tree<'_>>,
    path: &str,
) -> AppResult<Option<Vec<u8>>> {
    let Some(tree) = tree else {
        return Ok(None);
    };
    let entry = match tree.get_path(Path::new(path)) {
        Ok(entry) => entry,
        Err(e)
            if matches!(
                e.code(),
                git2::ErrorCode::NotFound | git2::ErrorCode::Ambiguous
            ) =>
        {
            return Ok(None);
        }
        Err(e) => return Err(AppError::Git(format!("读取树条目 {path} 失败: {e}"))),
    };
    if entry.kind() != Some(git2::ObjectType::Blob) {
        return Ok(None);
    }
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| AppError::Git(format!("读取 blob {path} 失败: {e}")))?;
    Ok(Some(blob.content().to_vec()))
}

pub(super) fn blob_bytes_from_index(
    repo: &git2::Repository,
    index: &git2::Index,
    path: &str,
) -> AppResult<Option<Vec<u8>>> {
    let Some(entry) = index.get_path(Path::new(path), 0) else {
        return Ok(None);
    };
    let blob = repo
        .find_blob(entry.id)
        .map_err(|e| AppError::Git(format!("读取 index blob {path} 失败: {e}")))?;
    Ok(Some(blob.content().to_vec()))
}

fn build_file_diff(
    old: Option<Vec<u8>>,
    new: Option<Vec<u8>>,
    old_path: Option<String>,
    new_path: Option<String>,
    change_type: ChangeType,
) -> FileDiffResult {
    if old.as_deref().is_some_and(is_binary_bytes) || new.as_deref().is_some_and(is_binary_bytes) {
        return FileDiffResult {
            old_path,
            new_path,
            change_type: ChangeType::Binary,
            is_binary: true,
            too_large: false,
            rows: Vec::new(),
            change_row_indices: Vec::new(),
            additions: 0,
            deletions: 0,
        };
    }

    let old_text = old.map(|b| String::from_utf8_lossy(&b).into_owned());
    let new_text = new.map(|b| String::from_utf8_lossy(&b).into_owned());
    let byte_total =
        old_text.as_deref().map_or(0, str::len) + new_text.as_deref().map_or(0, str::len);
    let line_total = old_text.as_deref().map_or(0, |s| s.lines().count())
        + new_text.as_deref().map_or(0, |s| s.lines().count());
    if byte_total > MAX_DIFF_BYTES || line_total > MAX_DIFF_LINES {
        return FileDiffResult {
            old_path,
            new_path,
            change_type,
            is_binary: false,
            too_large: true,
            rows: Vec::new(),
            change_row_indices: Vec::new(),
            additions: 0,
            deletions: 0,
        };
    }

    let old_str = old_text.as_deref().unwrap_or_default();
    let new_str = new_text.as_deref().unwrap_or_default();
    let rows = diff_engine::diff_strings(old_str, new_str, &TextDiffOptions::default());
    let change_row_indices = diff_engine::compute_change_row_indices(&rows);
    let (additions, deletions) = diff_engine::compute_stats(&rows);
    FileDiffResult {
        old_path,
        new_path,
        change_type,
        is_binary: false,
        too_large: false,
        rows,
        change_row_indices,
        additions,
        deletions,
    }
}

pub(super) fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_LEN).any(|&b| b == 0)
}

fn is_binary_blob(repo: &git2::Repository, oid: git2::Oid) -> bool {
    if oid.is_zero() {
        return false;
    }
    match repo.find_blob(oid) {
        Ok(blob) => is_binary_bytes(blob.content()),
        Err(_) => false,
    }
}
