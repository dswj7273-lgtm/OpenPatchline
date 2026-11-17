//! 提交创建、模板/签名元数据、历史签名校验与合并收尾子模块（含 4.4 增强）。

use std::path::{Path, PathBuf};

use super::{find_commit, fresh_index, head_commit, repo_state};
use crate::error::{AppError, AppResult};
use crate::git_remote::run_git_with_input;
use crate::types::{CommitMetadata, CommitSignatureInfo, RepoState, SignatureStatus};

/// 提交签名回退用户名（仓库与全局配置、$USER 均缺失时）。
const FALLBACK_SIGNATURE_NAME: &str = "OpenPatchline";
/// 提交签名回退邮箱。
const FALLBACK_SIGNATURE_EMAIL: &str = "openpatchline@local";
/// 读取 commit.template 模板的最大字节数（64KB）。
const MAX_TEMPLATE_BYTES: usize = 64 * 1024;

/// 将当前 index 内容创建为一个提交，返回新提交 id（沿用仓库签名配置或无签名提交）。
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

/// 创建提交（可选强制开启或关闭 GPG / SSH 签名）。
///
/// - `sign = Some(true)`：通过 `git commit -S -F -` 调起系统 GPG / SSH 签名；
/// - `sign = Some(false)`：不签名，直接走快速的 libgit2 本地提交；
/// - `sign = None`：遵循仓库 `commit.gpgsign` 配置。
pub fn create_commit_with_options(
    repo: &mut git2::Repository,
    message: &str,
    sign: Option<bool>,
) -> AppResult<String> {
    let want_sign = match sign {
        Some(v) => v,
        None => read_gpgsign_config(repo),
    };
    if !want_sign {
        return create_commit(repo, message);
    }

    if repo_state(repo) == RepoState::Rebasing {
        return Err(AppError::InvalidArg(
            "正在进行 Rebase，请解决冲突并暂存后使用「继续」完成变基".to_string(),
        ));
    }
    let index = fresh_index(repo)?;
    if index.has_conflicts() {
        return Err(AppError::Git(
            "仍有未解决的冲突文件，请先解决冲突并标记为已解决".to_string(),
        ));
    }
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?
        .to_path_buf();

    let mut args: Vec<String> = Vec::new();
    if repo.signature().is_err() {
        let sig = commit_signature(repo)?;
        args.push("-c".to_string());
        args.push(format!(
            "user.name={}",
            sig.name().unwrap_or(FALLBACK_SIGNATURE_NAME)
        ));
        args.push("-c".to_string());
        args.push(format!(
            "user.email={}",
            sig.email().unwrap_or(FALLBACK_SIGNATURE_EMAIL)
        ));
    }
    args.extend(["commit", "-S", "-F", "-"].into_iter().map(str::to_string));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_with_input(&workdir, &arg_refs, Some(message.as_bytes()))?;

    let commit = head_commit(repo)?
        .ok_or_else(|| AppError::Unexpected("提交成功但未找到 HEAD 提交".to_string()))?;
    Ok(commit.id().to_string())
}

/// 读取提交面板所需的模板与签名配置元数据。
pub fn commit_metadata(repo: &git2::Repository) -> AppResult<CommitMetadata> {
    let Ok(cfg) = repo.config().and_then(|mut c| c.snapshot()) else {
        return Ok(CommitMetadata {
            commit_template: None,
            gpg_sign_enabled: false,
            signing_key: None,
            gpg_format: "openpgp".to_string(),
        });
    };

    let gpg_sign_enabled = cfg.get_bool("commit.gpgsign").unwrap_or(false);
    let signing_key = cfg
        .get_string("user.signingkey")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let gpg_format = cfg
        .get_string("gpg.format")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "openpgp".to_string());

    let commit_template = cfg
        .get_string("commit.template")
        .ok()
        .and_then(|raw| read_commit_template(repo.workdir(), &raw));

    Ok(CommitMetadata {
        commit_template,
        gpg_sign_enabled,
        signing_key,
        gpg_format,
    })
}

/// 校验指定提交的 GPG / SSH 签名状态。
pub fn commit_signature_info(
    repo: &git2::Repository,
    commit_id: &str,
) -> AppResult<CommitSignatureInfo> {
    let commit = find_commit(repo, commit_id)?;
    let oid = commit.id();
    let oid_str = oid.to_string();
    let has_sig_header = repo.extract_signature(&oid, Some("gpgsig")).is_ok();

    let Some(workdir) = repo.workdir() else {
        return Ok(CommitSignatureInfo {
            commit_id: oid_str,
            status: if has_sig_header {
                SignatureStatus::Unverifiable
            } else {
                SignatureStatus::Unsigned
            },
            signer: None,
            key_id: None,
        });
    };

    let args = ["log", "-1", "--format=%G?%x09%GS%x09%GK", &oid_str];
    let Ok((stdout, _)) = run_git_with_input(workdir, &args, None) else {
        return Ok(CommitSignatureInfo {
            commit_id: oid_str,
            status: if has_sig_header {
                SignatureStatus::Unverifiable
            } else {
                SignatureStatus::Unsigned
            },
            signer: None,
            key_id: None,
        });
    };

    Ok(parse_signature_output(&oid_str, has_sig_header, &stdout))
}

pub(super) fn parse_signature_output(
    commit_id: &str,
    has_sig_header: bool,
    stdout: &str,
) -> CommitSignatureInfo {
    let line = stdout
        .lines()
        .next()
        .unwrap_or_default()
        .trim_end_matches('\r');
    let mut parts = line.splitn(3, '\t');
    let code = parts.next().unwrap_or_default().trim();
    let signer = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let key_id = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let status = match code {
        "G" => SignatureStatus::Verified,
        "U" => SignatureStatus::Untrusted,
        "B" => SignatureStatus::Bad,
        "X" | "Y" => SignatureStatus::Expired,
        "R" => SignatureStatus::Revoked,
        "E" => SignatureStatus::Unverifiable,
        "N" | "" => {
            if has_sig_header {
                SignatureStatus::Unverifiable
            } else {
                SignatureStatus::Unsigned
            }
        }
        _ => SignatureStatus::Unverifiable,
    };

    CommitSignatureInfo {
        commit_id: commit_id.to_string(),
        status,
        signer,
        key_id,
    }
}

fn read_gpgsign_config(repo: &git2::Repository) -> bool {
    repo.config()
        .and_then(|mut c| c.snapshot())
        .and_then(|s| s.get_bool("commit.gpgsign"))
        .unwrap_or(false)
}

fn read_commit_template(workdir: Option<&Path>, raw_path: &str) -> Option<String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let resolved = resolve_template_path(workdir, trimmed)?;
    let bytes = std::fs::read(resolved).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_TEMPLATE_BYTES {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    // 剥离 Git 注释行（以 `#` 开头），避免 GUI 直接提交时将注释误提交进正文。
    let cleaned_lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect();
    let cleaned = cleaned_lines.join("\n").trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn resolve_template_path(workdir: Option<&Path>, raw: &str) -> Option<PathBuf> {
    if let Some(rest) = raw.strip_prefix("~/") {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
        return Some(PathBuf::from(home).join(rest));
    }
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        Some(p)
    } else {
        workdir.map(|w| w.join(p))
    }
}

/// 提交签名：优先仓库/全局配置，缺失时回退 $USER（再缺则 OpenPatchline）。
pub(super) fn commit_signature(repo: &git2::Repository) -> AppResult<git2::Signature<'static>> {
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
