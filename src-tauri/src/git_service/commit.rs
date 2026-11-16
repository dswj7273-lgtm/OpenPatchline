//! 提交创建与合并/挑选/撤销收尾子模块。

use super::{fresh_index, head_commit, repo_state};
use crate::error::{AppError, AppResult};
use crate::types::RepoState;

/// 提交签名回退用户名（仓库与全局配置、$USER 均缺失时）。
const FALLBACK_SIGNATURE_NAME: &str = "OpenPatchline";
/// 提交签名回退邮箱。
const FALLBACK_SIGNATURE_EMAIL: &str = "openpatchline@local";

/// 将当前 index 内容创建为一个提交，返回新提交 id。
pub fn create_commit(repo: &mut git2::Repository, message: &str) -> AppResult<String> {
    if repo_state(repo) == RepoState::Rebasing {
        return Err(AppError::InvalidArg(
            "正在进行 Rebase，请解决冲突并暂存后使用「继续」完成变基".to_string(),
        ));
    }
    let signature = commit_signature(repo)?;
    let mut index = fresh_index(repo)?;
    if index.has_conflicts() {
        return Err(AppError::Git(
            "仍有未解决的冲突文件，请先解决冲突并标记为已解决".to_string(),
        ));
    }
    let tree_oid = index
        .write_tree_to(repo)
        .map_err(|e| AppError::Git(format!("从 index 写树失败: {e}")))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| AppError::Git(format!("读取树 {tree_oid} 失败: {e}")))?;

    let merge_head = repo
        .find_reference("MERGE_HEAD")
        .ok()
        .map(|r| r.peel_to_commit())
        .transpose()
        .map_err(|e| AppError::Git(format!("解析 MERGE_HEAD 失败: {e}")))?;

    let mut parents: Vec<git2::Commit<'_>> = match head_commit(repo)? {
        Some(head) => vec![head],
        None => Vec::new(),
    };
    if let Some(merge_commit) = &merge_head {
        parents.push(merge_commit.clone());
        if parents.len() == 1 {
            return Err(AppError::Git(
                "合并进行中但 HEAD 不存在，状态异常".to_string(),
            ));
        }
    }
    let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
    let oid = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parent_refs,
        )
        .map_err(|e| AppError::Git(format!("创建提交失败: {e}")))?;

    for refname in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] {
        if let Ok(mut reference) = repo.find_reference(refname) {
            let _ = reference.delete();
        }
    }
    let gitdir = repo.path();
    for file in ["MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"] {
        let _ = std::fs::remove_file(gitdir.join(file));
    }
    Ok(oid.to_string())
}

/// 提交签名：优先仓库/全局配置，缺失时回退 $USER（再缺则 OpenPatchline）。
fn commit_signature(repo: &git2::Repository) -> AppResult<git2::Signature<'static>> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig);
    }
    let name = std::env::var("USER")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| FALLBACK_SIGNATURE_NAME.to_string());
    git2::Signature::now(&name, FALLBACK_SIGNATURE_EMAIL)
        .map_err(|e| AppError::InvalidArg(format!("构造提交签名失败: {e}")))
}
