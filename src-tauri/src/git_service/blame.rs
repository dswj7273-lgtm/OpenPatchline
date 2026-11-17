//! Git Blame 查询子模块（逐行追溯最后修改提交与历史钻取）。

use std::collections::HashMap;

use super::diff::{blob_bytes_from_tree, is_binary_bytes};
use super::{read_workdir_file, validate_rel_path};
use crate::error::{AppError, AppResult};
use crate::types::{BlameCommitInfo, BlameLine, FileBlameResult};

/// Blame 单文件体积上限（2 MB）。
const MAX_BLAME_BYTES: usize = 2 * 1024 * 1024;
/// Blame 单文件行数上限（20,000 行）。
const MAX_BLAME_LINES: usize = 20_000;
/// 零 OID 字符串（git2 对未提交缓冲行使用的全零哈希）。
const ZERO_OID_HEX: &str = "0000000000000000000000000000000000000000";

/// 计算指定文件在 `commit_id`（或工作区/HEAD）下的逐行 Blame。
pub fn file_blame(
    repo: &git2::Repository,
    path: &str,
    commit_id: Option<&str>,
) -> AppResult<FileBlameResult> {
    let rel = validate_rel_path(path)?;
    let mut opts = git2::BlameOptions::new();
    opts.track_copies_same_file(true).use_mailmap(true);

    let (resolved_commit_id, bytes, blame) =
        match commit_id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(target_ref) => {
                let obj = repo
                    .revparse_single(target_ref)
                    .map_err(|_| AppError::NotFound(format!("提交或引用不存在: {target_ref}")))?;
                let commit = obj.peel_to_commit().map_err(|e| {
                    AppError::NotFound(format!("目标 {target_ref} 不指向提交: {e}"))
                })?;
                let tree = commit
                    .tree()
                    .map_err(|e| AppError::Git(format!("读取提交树失败: {e}")))?;
                let bytes = blob_bytes_from_tree(repo, Some(&tree), path)?.ok_or_else(|| {
                    AppError::NotFound(format!("提交 {} 中不存在文件 {path}", commit.id()))
                })?;
                if is_binary_bytes(&bytes) {
                    return Ok(binary_blame_result(path, Some(commit.id().to_string())));
                }
                if bytes.len() > MAX_BLAME_BYTES {
                    return Ok(too_large_blame_result(path, Some(commit.id().to_string())));
                }
                opts.newest_commit(commit.id());
                let blame = repo
                    .blame_file(rel, Some(&mut opts))
                    .map_err(|e| AppError::Git(format!("计算 {path} Blame 失败: {e}")))?;
                (Some(commit.id().to_string()), bytes, blame)
            }
            None => {
                let workdir = repo
                    .workdir()
                    .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
                let workdir_bytes = read_workdir_file(workdir, path)?;
                let base_blame = match repo.blame_file(rel, Some(&mut opts)) {
                    Ok(b) => b,
                    Err(e) if matches!(e.code(), git2::ErrorCode::NotFound) => {
                        return Err(AppError::NotFound(format!(
                            "文件 {path} 尚未提交到 Git 历史，暂无 Blame 记录"
                        )));
                    }
                    Err(e) => return Err(AppError::Git(format!("计算 {path} Blame 失败: {e}"))),
                };
                if let Some(bytes) = workdir_bytes {
                    if is_binary_bytes(&bytes) {
                        return Ok(binary_blame_result(path, None));
                    }
                    if bytes.len() > MAX_BLAME_BYTES {
                        return Ok(too_large_blame_result(path, None));
                    }
                    let buffered = base_blame
                        .blame_buffer(&bytes)
                        .map_err(|e| AppError::Git(format!("计算工作区 {path} Blame 失败: {e}")))?;
                    // 把 BlameResult 的构建与生命周期内完成，不让 buffered 逃逸此分支
                    return build_blame_result(path, None, &bytes, &buffered, repo);
                }
                let head_tree = super::head_tree(repo)?;
                let bytes =
                    blob_bytes_from_tree(repo, head_tree.as_ref(), path)?.ok_or_else(|| {
                        AppError::NotFound(format!("工作区与 HEAD 中均不存在文件 {path}"))
                    })?;
                if is_binary_bytes(&bytes) {
                    return Ok(binary_blame_result(path, None));
                }
                if bytes.len() > MAX_BLAME_BYTES {
                    return Ok(too_large_blame_result(path, None));
                }
                (None, bytes, base_blame)
            }
        };

    build_blame_result(path, resolved_commit_id, &bytes, &blame, repo)
}

fn build_blame_result(
    path: &str,
    commit_id: Option<String>,
    bytes: &[u8],
    blame: &git2::Blame<'_>,
    repo: &git2::Repository,
) -> AppResult<FileBlameResult> {
    let text = String::from_utf8_lossy(bytes);
    let raw_lines = split_blame_lines(&text);
    if raw_lines.len() > MAX_BLAME_LINES {
        return Ok(too_large_blame_result(path, commit_id));
    }

    let mut commits: HashMap<String, BlameCommitInfo> = HashMap::new();
    let mut lines: Vec<BlameLine> = Vec::with_capacity(raw_lines.len());

    for (idx, content) in raw_lines.into_iter().enumerate() {
        let lineno = (idx + 1) as u32;
        let hunk = blame.get_line(lineno as usize);
        let (hunk_commit_id, orig_line_no, orig_path) = match hunk {
            Some(ref h) => {
                let oid = h.final_commit_id();
                let cid = if oid.is_zero() {
                    ZERO_OID_HEX.to_string()
                } else {
                    oid.to_string()
                };
                if !commits.contains_key(&cid) {
                    let info = build_commit_info(repo, oid, h);
                    commits.insert(cid.clone(), info);
                }
                let offset = (lineno as usize).saturating_sub(h.final_start_line());
                let orig_ln = (h.orig_start_line() + offset) as u32;
                let orig_p = h
                    .path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .filter(|p| p != path);
                (cid, orig_ln, orig_p)
            }
            None => {
                if !commits.contains_key(ZERO_OID_HEX) {
                    commits.insert(ZERO_OID_HEX.to_string(), uncommitted_commit_info());
                }
                (ZERO_OID_HEX.to_string(), lineno, None)
            }
        };

        lines.push(BlameLine {
            line_no: lineno,
            orig_line_no,
            orig_path,
            commit_id: hunk_commit_id,
            content,
        });
    }

    Ok(FileBlameResult {
        path: path.to_string(),
        commit_id,
        is_binary: false,
        too_large: false,
        commits,
        lines,
    })
}

fn build_commit_info(
    repo: &git2::Repository,
    oid: git2::Oid,
    hunk: &git2::BlameHunk<'_>,
) -> BlameCommitInfo {
    if oid.is_zero() {
        return uncommitted_commit_info();
    }
    if let Ok(commit) = repo.find_commit(oid) {
        let id = oid.to_string();
        let short_id = id.chars().take(7).collect();
        let author = commit.author();
        let author_name = author.name().unwrap_or("Unknown").to_string();
        let author_email = author.email().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let summary = commit.summary().ok().flatten().unwrap_or("").to_string();
        let parent_ids = commit.parent_ids().map(|p| p.to_string()).collect();
        return BlameCommitInfo {
            id,
            short_id,
            author_name,
            author_email,
            timestamp,
            summary,
            parent_ids,
            is_uncommitted: false,
        };
    }

    let id = oid.to_string();
    let short_id = id.chars().take(7).collect();
    let sig = hunk.final_signature();
    let author_name = sig
        .as_ref()
        .and_then(|s| s.name().ok())
        .unwrap_or("Unknown")
        .to_string();
    let author_email = sig
        .as_ref()
        .and_then(|s| s.email().ok())
        .unwrap_or("")
        .to_string();
    let timestamp = sig.as_ref().map(|s| s.when().seconds()).unwrap_or(0);
    let summary = hunk.summary().ok().flatten().unwrap_or("").to_string();
    BlameCommitInfo {
        id,
        short_id,
        author_name,
        author_email,
        timestamp,
        summary,
        parent_ids: Vec::new(),
        is_uncommitted: false,
    }
}

fn uncommitted_commit_info() -> BlameCommitInfo {
    BlameCommitInfo {
        id: ZERO_OID_HEX.to_string(),
        short_id: "0000000".to_string(),
        author_name: "当前工作区".to_string(),
        author_email: String::new(),
        timestamp: 0,
        summary: "尚未提交的本地修改".to_string(),
        parent_ids: Vec::new(),
        is_uncommitted: true,
    }
}

fn split_blame_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<String> = text
        .split('\n')
        .map(|s| s.strip_suffix('\r').unwrap_or(s).to_string())
        .collect();
    if text.ends_with('\n') {
        parts.pop();
    }
    parts
}

fn binary_blame_result(path: &str, commit_id: Option<String>) -> FileBlameResult {
    FileBlameResult {
        path: path.to_string(),
        commit_id,
        is_binary: true,
        too_large: false,
        commits: HashMap::new(),
        lines: Vec::new(),
    }
}

fn too_large_blame_result(path: &str, commit_id: Option<String>) -> FileBlameResult {
    FileBlameResult {
        path: path.to_string(),
        commit_id,
        is_binary: false,
        too_large: true,
        commits: HashMap::new(),
        lines: Vec::new(),
    }
}
