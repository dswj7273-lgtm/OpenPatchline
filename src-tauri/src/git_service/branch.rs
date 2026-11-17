//! 分支列表与检出（含远程分支 DWIM 跟踪）子模块。

use crate::error::{AppError, AppResult};
use crate::types::{BranchInfo, BranchKind};

/// 列出本地与远程分支（本地在前，各组内按名称排序）。
pub fn list_branches(repo: &git2::Repository) -> AppResult<Vec<BranchInfo>> {
    let head_name = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string));

    let mut locals: Vec<BranchInfo> = Vec::new();
    let mut remotes: Vec<BranchInfo> = Vec::new();
    let branches = repo
        .branches(None)
        .map_err(|e| AppError::Git(format!("枚举分支失败: {e}")))?;
    for entry in branches {
        let (branch, branch_type) =
            entry.map_err(|e| AppError::Git(format!("枚举分支失败: {e}")))?;
        if branch.get().symbolic_target().ok().flatten().is_some() {
            continue;
        }
        let Some(name) = branch.name().ok().flatten().map(str::to_string) else {
            continue;
        };
        let commit = branch
            .get()
            .peel_to_commit()
            .map_err(|e| AppError::Git(format!("解析分支 {name} 顶端提交失败: {e}")))?;

        match branch_type {
            git2::BranchType::Local => {
                let is_current = head_name.as_deref() == Some(name.as_str());
                let (upstream, ahead, behind) = match branch.upstream() {
                    Ok(upstream_branch) => {
                        let upstream_name =
                            upstream_branch.name().ok().flatten().map(str::to_string);
                        let ahead_behind = upstream_name.as_deref().and_then(|_| {
                            upstream_branch
                                .get()
                                .peel_to_commit()
                                .ok()
                                .and_then(|up_commit| {
                                    repo.graph_ahead_behind(commit.id(), up_commit.id()).ok()
                                })
                        });
                        match (upstream_name, ahead_behind) {
                            (Some(u), Some((a, b))) => (Some(u), Some(a), Some(b)),
                            (Some(u), None) => (Some(u), None, None),
                            _ => (None, None, None),
                        }
                    }
                    Err(_) => (None, None, None),
                };
                locals.push(BranchInfo {
                    name,
                    kind: BranchKind::Local,
                    is_current,
                    upstream,
                    ahead,
                    behind,
                    tip_commit: commit.id().to_string(),
                });
            }
            git2::BranchType::Remote => remotes.push(BranchInfo {
                name,
                kind: BranchKind::Remote,
                is_current: false,
                upstream: None,
                ahead: None,
                behind: None,
                tip_commit: commit.id().to_string(),
            }),
        }
    }
    locals.sort_by(|a, b| a.name.cmp(&b.name));
    remotes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok([locals, remotes].concat())
}

/// 切换分支（本地直接切换；远程分支 DWIM 创建跟踪分支）。
pub fn checkout_branch(repo: &mut git2::Repository, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidArg("分支名不能为空".to_string()));
    }
    if !git2::Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(AppError::InvalidArg(format!("非法分支名: {name}")));
    }

    enum Target {
        Local(String),
        CreateTracking { short: String },
    }

    let target = if repo.find_branch(name, git2::BranchType::Local).is_ok() {
        Target::Local(name.to_string())
    } else if let Ok(remote_branch) = repo.find_branch(name, git2::BranchType::Remote) {
        let remote_oid = remote_branch.get().peel_to_commit().ok().map(|c| c.id());
        drop(remote_branch);
        let (_remote_name, short) = split_remote_branch(repo, name)?;
        if let Ok(local_branch) = repo.find_branch(&short, git2::BranchType::Local) {
            let local_oid = local_branch.get().peel_to_commit().ok().map(|c| c.id());
            let tracks_remote = local_branch
                .upstream()
                .ok()
                .and_then(|u| u.name().ok().flatten().map(str::to_string))
                .as_deref()
                == Some(name);
            if local_oid.is_some() && local_oid == remote_oid && tracks_remote {
                Target::Local(short)
            } else {
                return Err(AppError::InvalidArg(format!(
                    "本地分支 {short} 已存在且与远程分支 {name} 提交或跟踪关系不一致，请先直接切换到 {short} 并同步或删除后再检出 {name}"
                )));
            }
        } else {
            Target::CreateTracking { short }
        }
    } else {
        return Err(AppError::NotFound(format!("分支不存在: {name}")));
    };

    {
        let (target_name, tree) = match &target {
            Target::Local(branch) => (branch.clone(), branch_tree(repo, branch)?),
            Target::CreateTracking { short: _ } => (name.to_string(), branch_tree(repo, name)?),
        };
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.safe();
        repo.checkout_tree(tree.as_object(), Some(&mut checkout))
            .map_err(|e| {
                AppError::Git(format!(
                    "切换到分支 {target_name} 失败（本地有未提交修改会被覆盖时请先提交或暂存）: {e}"
                ))
            })?;
    }

    let final_name = match target {
        Target::Local(branch) => branch,
        Target::CreateTracking { short } => {
            create_tracking_branch(repo, name, &short)?;
            short
        }
    };
    let refname = format!("refs/heads/{final_name}");
    repo.set_head(&refname)
        .map_err(|e| AppError::Git(format!("移动 HEAD 到 {final_name} 失败: {e}")))?;
    Ok(())
}

fn branch_tree<'r>(repo: &'r git2::Repository, branch: &str) -> AppResult<git2::Tree<'r>> {
    repo.find_reference(&format!("refs/heads/{branch}"))
        .or_else(|_| repo.find_reference(&format!("refs/remotes/{branch}")))
        .map_err(|e| AppError::NotFound(format!("分支不存在: {branch} ({e})")))?
        .peel_to_commit()
        .map_err(|e| AppError::Git(format!("解析分支 {branch} 顶端提交失败: {e}")))?
        .tree()
        .map_err(|e| AppError::Git(format!("读取分支 {branch} 树失败: {e}")))
}

fn create_tracking_branch(
    repo: &mut git2::Repository,
    remote_ref: &str,
    short: &str,
) -> AppResult<()> {
    let (remote_name, _) = split_remote_branch(repo, remote_ref)?;
    let commit = repo
        .find_branch(remote_ref, git2::BranchType::Remote)
        .map_err(|e| AppError::NotFound(format!("分支不存在: {remote_ref} ({e})")))?
        .get()
        .peel_to_commit()
        .map_err(|e| AppError::Git(format!("解析 {remote_ref} 顶端提交失败: {e}")))?;
    repo.branch(short, &commit, false)
        .map_err(|e| AppError::Git(format!("创建本地分支 {short} 失败: {e}")))?;
    let mut config = repo
        .config()
        .map_err(|e| AppError::Git(format!("读取仓库配置失败: {e}")))?;
    config
        .set_str(&format!("branch.{short}.remote"), &remote_name)
        .map_err(|e| AppError::Git(format!("配置 branch.{short}.remote 失败: {e}")))?;
    config
        .set_str(
            &format!("branch.{short}.merge"),
            &format!("refs/heads/{short}"),
        )
        .map_err(|e| AppError::Git(format!("配置 branch.{short}.merge 失败: {e}")))?;
    Ok(())
}

fn split_remote_branch(repo: &git2::Repository, name: &str) -> AppResult<(String, String)> {
    let remotes = repo
        .remotes()
        .map_err(|e| AppError::Git(format!("枚举远程失败: {e}")))?;
    let mut names: Vec<&str> = (0..remotes.len())
        .filter_map(|i| remotes.get(i).ok().flatten())
        .collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    for remote in names {
        if let Some(rest) = name.strip_prefix(remote)
            && let Some(short) = rest.strip_prefix('/')
            && !short.is_empty()
        {
            return Ok((remote.to_string(), short.to_string()));
        }
    }
    Err(AppError::InvalidArg(format!(
        "无法从 {name} 推导本地分支名（对应远程未配置？）"
    )))
}

/// 列出包含指定提交的分支（本地 + 远程，`git branch --contains` 语义，v0.7 / 7.5）。
pub fn branches_containing(repo: &git2::Repository, commit_id: &str) -> AppResult<Vec<String>> {
    let commit = super::find_commit(repo, commit_id)?;
    let target = commit.id();
    let mut names: Vec<String> = Vec::new();
    for ty in [git2::BranchType::Local, git2::BranchType::Remote] {
        let branches = repo
            .branches(Some(ty))
            .map_err(|e| AppError::Git(format!("枚举分支失败: {e}")))?;
        for branch in branches {
            let (branch, _) = branch
                .map_err(|e| AppError::Git(format!("枚举分支失败: {e}")))?;
            let tip = match branch.get().peel_to_commit() {
                Ok(c) => c,
                Err(_) => continue,
            };
            // target 是 tip 的祖先（或同一提交）→ 该分支包含此提交。
            let contains = tip.id() == target
                || repo
                    .merge_base(tip.id(), target)
                    .is_ok_and(|base| base == target);
            if contains
                && let Some(name) = branch.name().ok().flatten()
            {
                names.push(name.to_string());
            }
        }
    }
    Ok(names)
}
