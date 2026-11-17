//! 三方合并冲突详情读取与解决写入子模块。

use std::path::Path;

use super::diff::is_binary_bytes;
use super::{fresh_index, read_workdir_file, resolve_workdir_path, stage_file, validate_rel_path};
use crate::error::{AppError, AppResult};
use crate::types::ConflictFileDetail;

/// 单侧冲突内容保护阈值（字节）：超过 5MB 时置 `too_large`。
const MAX_CONFLICT_BYTES: usize = 5 * 1024 * 1024;

/// 读取指定路径的冲突三方快照（Base / Ours / Theirs）及当前工作区文件内容。
pub fn get_conflict_file(repo: &git2::Repository, path: &str) -> AppResult<ConflictFileDetail> {
    let rel = validate_rel_path(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
    let index = fresh_index(repo)?;
    let conflict = index.conflict_get(rel).map_err(|e| {
        if matches!(e.code(), git2::ErrorCode::NotFound) {
            AppError::NotFound(format!("文件 {path} 当前不存在合并冲突"))
        } else {
            AppError::Git(format!("读取冲突索引失败: {e}"))
        }
    })?;

    let base_bytes = read_index_entry_blob(repo, conflict.ancestor.as_ref(), path, "base")?;
    let ours_bytes = read_index_entry_blob(repo, conflict.our.as_ref(), path, "ours")?;
    let theirs_bytes = read_index_entry_blob(repo, conflict.their.as_ref(), path, "theirs")?;
    let workdir_bytes = read_workdir_file(workdir, path)?;

    let base_exists = base_bytes.is_some();
    let ours_exists = ours_bytes.is_some();
    let theirs_exists = theirs_bytes.is_some();
    let workdir_exists = workdir_bytes.is_some();

    let is_binary = [
        base_bytes.as_deref(),
        ours_bytes.as_deref(),
        theirs_bytes.as_deref(),
        workdir_bytes.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(is_binary_bytes);

    if is_binary {
        let (ours_label, theirs_label) = resolve_conflict_labels(repo, None);
        return Ok(ConflictFileDetail {
            path: path.to_string(),
            is_binary: true,
            too_large: false,
            base_exists,
            ours_exists,
            theirs_exists,
            workdir_exists,
            base_content: String::new(),
            ours_content: String::new(),
            theirs_content: String::new(),
            workdir_content: String::new(),
            ours_label,
            theirs_label,
        });
    }

    let too_large = [
        base_bytes.as_deref(),
        ours_bytes.as_deref(),
        theirs_bytes.as_deref(),
        workdir_bytes.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|b| b.len() > MAX_CONFLICT_BYTES);

    if too_large {
        let (ours_label, theirs_label) = resolve_conflict_labels(repo, None);
        return Ok(ConflictFileDetail {
            path: path.to_string(),
            is_binary: false,
            too_large: true,
            base_exists,
            ours_exists,
            theirs_exists,
            workdir_exists,
            base_content: String::new(),
            ours_content: String::new(),
            theirs_content: String::new(),
            workdir_content: String::new(),
            ours_label,
            theirs_label,
        });
    }

    let base_content = bytes_to_string(base_bytes);
    let ours_content = bytes_to_string(ours_bytes);
    let theirs_content = bytes_to_string(theirs_bytes);
    let workdir_content = bytes_to_string(workdir_bytes);
    let (ours_label, theirs_label) = resolve_conflict_labels(repo, Some(&workdir_content));

    Ok(ConflictFileDetail {
        path: path.to_string(),
        is_binary: false,
        too_large: false,
        base_exists,
        ours_exists,
        theirs_exists,
        workdir_exists,
        base_content,
        ours_content,
        theirs_content,
        workdir_content,
        ours_label,
        theirs_label,
    })
}

/// 将用户解决后的文本写回工作区（或删除文件），并按需标记为已解决（暂存到 index）。
pub fn resolve_conflict_file(
    repo: &mut git2::Repository,
    path: &str,
    content: &str,
    stage: bool,
    delete_file: bool,
) -> AppResult<()> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
    let full = resolve_workdir_path(workdir, path)?;

    if delete_file {
        match std::fs::symlink_metadata(&full) {
            Ok(meta) => {
                if meta.is_dir() && !meta.file_type().is_symlink() {
                    return Err(AppError::InvalidArg(format!(
                        "目标路径是目录，无法按冲突文件删除: {path}"
                    )));
                }
                std::fs::remove_file(&full)
                    .map_err(|e| AppError::Io(format!("删除冲突文件 {path} 失败: {e}")))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::Io(format!("读取冲突文件 {path} 失败: {e}"))),
        }
    } else {
        if let Ok(meta) = std::fs::symlink_metadata(&full) {
            if meta.file_type().is_symlink() {
                return Err(AppError::InvalidArg(format!(
                    "拒绝覆盖工作区符号链接文件: {path}"
                )));
            }
            if meta.is_dir() {
                return Err(AppError::InvalidArg(format!(
                    "目标路径是目录，无法写入冲突内容: {path}"
                )));
            }
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Io(format!("创建父目录失败: {e}")))?;
        }
        std::fs::write(&full, content.as_bytes())
            .map_err(|e| AppError::Io(format!("写入解决结果到 {path} 失败: {e}")))?;
    }

    if stage {
        stage_file(repo, path)?;
    }
    Ok(())
}

fn read_index_entry_blob(
    repo: &git2::Repository,
    entry: Option<&git2::IndexEntry>,
    path: &str,
    stage_name: &str,
) -> AppResult<Option<Vec<u8>>> {
    let Some(entry) = entry else {
        return Ok(None);
    };
    let blob = repo
        .find_blob(entry.id)
        .map_err(|e| AppError::Git(format!("读取 {path} ({stage_name}) blob 失败: {e}")))?;
    Ok(Some(blob.content().to_vec()))
}

fn bytes_to_string(bytes: Option<Vec<u8>>) -> String {
    bytes
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

fn resolve_conflict_labels(
    repo: &git2::Repository,
    workdir_text: Option<&str>,
) -> (String, String) {
    if let Some(text) = workdir_text
        && let Some((ours, theirs)) = extract_marker_labels(text)
    {
        return (ours, theirs);
    }
    let ours = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_string))
        .unwrap_or_else(|| "HEAD".to_string());
    let git_dir = repo.path();
    let theirs = read_short_ref_label(git_dir, "MERGE_HEAD")
        .or_else(|| read_short_ref_label(git_dir, "REBASE_HEAD"))
        .or_else(|| read_short_ref_label(git_dir, "CHERRY_PICK_HEAD"))
        .or_else(|| read_short_ref_label(git_dir, "REVERT_HEAD"))
        .unwrap_or_else(|| "传入变更".to_string());
    (ours, theirs)
}

fn extract_marker_labels(text: &str) -> Option<(String, String)> {
    let mut ours: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("<<<<<<<") {
            let label = rest.trim();
            if !label.is_empty() {
                ours = Some(label.to_string());
            }
        } else if line.starts_with(">>>>>>>") {
            let label = line.trim_start_matches('>').trim();
            if let Some(o) = ours.take() {
                return Some((
                    o,
                    if label.is_empty() {
                        "Theirs".to_string()
                    } else {
                        label.to_string()
                    },
                ));
            }
        }
    }
    None
}

fn read_short_ref_label(git_dir: &Path, name: &str) -> Option<String> {
    let raw = std::fs::read_to_string(git_dir.join(name)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(7).collect())
}
