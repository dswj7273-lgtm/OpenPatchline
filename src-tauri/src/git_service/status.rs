//! 工作区状态查询与 stage / unstage 子模块。

use std::path::Path;

use super::{delta_change_type, fresh_index, head_commit};
use crate::error::{AppError, AppResult};
use crate::types::FileStatus;

/// 查询工作区状态：staged（index vs HEAD）与 unstaged（workdir vs index）及冲突文件。
pub fn status(repo: &git2::Repository) -> AppResult<Vec<FileStatus>> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AppError::Git(format!("读取工作区状态失败: {e}")))?;

    let mut out = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let Ok(path) = entry.path() else {
            continue;
        };
        let conflicted = entry.status().is_conflicted();
        let staged = if conflicted {
            None
        } else {
            entry
                .head_to_index()
                .and_then(|d| delta_change_type(d.status()))
        };
        let unstaged = if conflicted {
            None
        } else {
            entry
                .index_to_workdir()
                .and_then(|d| delta_change_type(d.status()))
        };
        if staged.is_none() && unstaged.is_none() && !conflicted {
            continue;
        }
        out.push(FileStatus {
            path: path.to_string(),
            staged,
            unstaged,
            conflicted,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// 暂存单个文件（Stage）；若路径处于冲突状态同时清除 stage 1/2/3 冲突条目。
pub fn stage_file(repo: &mut git2::Repository, path: &str) -> AppResult<()> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
    let mut index = fresh_index(repo)?;

    let rel = Path::new(path);
    let full = workdir.join(rel);
    if full.is_dir() {
        let pathspec = [rel.to_string_lossy().into_owned()];
        index
            .add_all(&pathspec, git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| AppError::Git(format!("暂存目录 {path} 失败: {e}")))?;
        index
            .update_all(&pathspec, None)
            .map_err(|e| AppError::Git(format!("同步目录 {path} 的删除失败: {e}")))?;
    } else if full.exists() {
        let _ = index.conflict_remove(rel);
        index
            .add_path(rel)
            .map_err(|e| AppError::Git(format!("暂存 {path} 失败: {e}")))?;
    } else {
        let _ = index.conflict_remove(rel);
        if index.get_path(rel, 0).is_some() {
            index
                .remove_path(rel)
                .map_err(|e| AppError::Git(format!("从 index 移除 {path} 失败: {e}")))?;
        }
    }
    index
        .write()
        .map_err(|e| AppError::Git(format!("写回 index 失败: {e}")))?;
    Ok(())
}

/// 取消暂存单个文件（Unstage）。
pub fn unstage_file(repo: &mut git2::Repository, path: &str) -> AppResult<()> {
    match head_commit(repo)? {
        Some(head) => {
            repo.reset_default(Some(head.as_object()), [path])
                .map_err(|e| AppError::Git(format!("重置 {path} 到 HEAD 失败: {e}")))?;
        }
        None => {
            let mut index = fresh_index(repo)?;
            if index.get_path(Path::new(path), 0).is_some() {
                index
                    .remove_path(Path::new(path))
                    .map_err(|e| AppError::Git(format!("从 index 移除 {path} 失败: {e}")))?;
                index
                    .write()
                    .map_err(|e| AppError::Git(format!("写回 index 失败: {e}")))?;
            }
        }
    }
    Ok(())
}
