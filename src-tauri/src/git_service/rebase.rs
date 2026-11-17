//! 轻量交互式变基子模块：支持对最近 N 个线性提交执行 Pick / Reword / Squash / Fixup（4.5）。
//!
//! 由于仅支持按原顺序保留、修改说明或向前合并（不重排、不丢弃提交），
//! 每个合并分组末端的 tree 与原提交树的增量完全一致，数学上不会产生合并冲突，
//! 且全程先构建新提交链，最后通过 `soft reset` 原子移动当前分支或 HEAD。

use super::commit::commit_signature;
use super::repo_state;
use super::status::status;
use crate::error::{AppError, AppResult};
use crate::types::{ChangeType, RebaseAction, RebaseCommitEntry, RebasePlanEntry, RepoState};

/// 允许一次性拉取/整理的最大最近线性提交数量。
const MAX_REBASE_COMMITS: usize = 50;

/// 读取从 HEAD 起最近最多 `limit` 个连续非合并线性提交（按时间从旧到新返回）。
pub fn list_rebase_commits(
    repo: &git2::Repository,
    limit: usize,
) -> AppResult<Vec<RebaseCommitEntry>> {
    let cap = limit.clamp(1, MAX_REBASE_COMMITS);
    let Ok(head) = repo.head() else {
        return Ok(Vec::new());
    };
    let mut cur = match head.peel_to_commit() {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut items = Vec::new();
    for _ in 0..cap {
        if cur.parent_count() > 1 {
            // 遇到 merge commit 立即截断，保持可线性重写范围。
            break;
        }
        let id = cur.id().to_string();
        let full_message = cur
            .message()
            .unwrap_or_default()
            .trim_end_matches('\n')
            .to_string();
        let subject = full_message.lines().next().unwrap_or_default().to_string();
        let (author_name, author_email, timestamp) = {
            let author = cur.author();
            (
                author.name().unwrap_or_default().to_string(),
                author.email().unwrap_or_default().to_string(),
                cur.time().seconds(),
            )
        };
        items.push(RebaseCommitEntry {
            short_id: id.chars().take(7).collect(),
            id,
            subject,
            full_message,
            author_name,
            author_email,
            timestamp,
        });

        if cur.parent_count() == 0 {
            break;
        }
        cur = cur
            .parent(0)
            .map_err(|e| AppError::Git(format!("读取父提交失败: {e}")))?;
    }

    items.reverse();
    Ok(items)
}

struct PlannedGroup {
    base_id: git2::Oid,
    last_id: git2::Oid,
    message: String,
}

/// 对最近 `plan.len()` 个连续线性提交执行轻量交互式整理（Pick / Reword / Squash / Fixup）。
pub fn rewrite_recent_commits(
    repo: &mut git2::Repository,
    plan: &[RebasePlanEntry],
) -> AppResult<String> {
    if plan.is_empty() {
        return Err(AppError::InvalidArg("提交整理计划不能为空".to_string()));
    }
    if plan.len() > MAX_REBASE_COMMITS {
        return Err(AppError::InvalidArg(format!(
            "单次最多整理 {MAX_REBASE_COMMITS} 个最近提交"
        )));
    }
    if repo_state(repo) != RepoState::Clean {
        return Err(AppError::InvalidArg(
            "仓库当前处于未完成操作状态，请先完成或中止当前操作".to_string(),
        ));
    }

    let statuses = status(repo)?;
    let has_dirty_tracked = statuses.iter().any(|s| {
        s.conflicted
            || s.staged.is_some()
            || (s.unstaged.is_some() && s.unstaged != Some(ChangeType::Untracked))
    });
    if has_dirty_tracked {
        return Err(AppError::InvalidArg(
            "工作区或暂存区存在未提交的更改，请先提交、暂存或贮藏后再整理历史".to_string(),
        ));
    }

    if matches!(plan[0].action, RebaseAction::Squash | RebaseAction::Fixup) {
        return Err(AppError::InvalidArg(
            "最早一条提交不能设为压缩（Squash/Fixup），请保持为保留或修改说明".to_string(),
        ));
    }

    let head_commit = repo
        .head()
        .map_err(|e| AppError::NotFound(format!("HEAD 不可用，无法整理提交: {e}")))?
        .peel_to_commit()
        .map_err(|e| AppError::Git(format!("解析 HEAD 提交失败: {e}")))?;

    let mut actual_ids: Vec<git2::Oid> = Vec::with_capacity(plan.len());
    let mut cur = head_commit.clone();
    for step_idx in 0..plan.len() {
        if cur.parent_count() > 1 {
            return Err(AppError::InvalidArg(
                "选定范围包含合并提交（merge commit），不支持轻量线性整理".to_string(),
            ));
        }
        actual_ids.push(cur.id());
        if step_idx + 1 < plan.len() {
            if cur.parent_count() == 0 {
                return Err(AppError::InvalidArg(
                    "提交数量超过仓库根提交，历史长度不匹配".to_string(),
                ));
            }
            cur = cur
                .parent(0)
                .map_err(|e| AppError::Git(format!("读取父提交失败: {e}")))?;
        }
    }

    let base_parent_id = if cur.parent_count() == 1 {
        Some(
            cur.parent_id(0)
                .map_err(|e| AppError::Git(format!("读取基准父提交失败: {e}")))?,
        )
    } else {
        None
    };

    // actual_ids 原为 HEAD -> oldest，反转为 oldest -> HEAD 以对齐 plan。
    actual_ids.reverse();
    for (idx, (entry, expected_oid)) in plan.iter().zip(actual_ids.iter()).enumerate() {
        let expected_str = expected_oid.to_string();
        if entry.commit_id != expected_str {
            return Err(AppError::InvalidArg(format!(
                "第 {} 条提交与当前 HEAD 历史不一致（期望 {}，实际 {}），请刷新后重试",
                idx + 1,
                &expected_str[..7.min(expected_str.len())],
                entry.commit_id
            )));
        }
    }

    if plan.iter().all(|e| e.action == RebaseAction::Pick) {
        return Ok(head_commit.id().to_string());
    }

    let mut groups: Vec<PlannedGroup> = Vec::new();
    for (entry, &oid) in plan.iter().zip(actual_ids.iter()) {
        let commit = repo
            .find_commit(oid)
            .map_err(|e| AppError::Git(format!("读取提交 {oid} 失败: {e}")))?;
        let raw_msg = commit
            .message()
            .unwrap_or_default()
            .trim_end_matches('\n')
            .to_string();

        match entry.action {
            RebaseAction::Pick => {
                groups.push(PlannedGroup {
                    base_id: oid,
                    last_id: oid,
                    message: raw_msg,
                });
            }
            RebaseAction::Reword => {
                let next_msg = entry
                    .message
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        AppError::InvalidArg("修改说明（Reword）的提交信息不能为空".to_string())
                    })?;
                groups.push(PlannedGroup {
                    base_id: oid,
                    last_id: oid,
                    message: next_msg.to_string(),
                });
            }
            RebaseAction::Squash => {
                let Some(last_group) = groups.last_mut() else {
                    return Err(AppError::InvalidArg(
                        "最早一条提交不能设为 Squash".to_string(),
                    ));
                };
                last_group.last_id = oid;
                // 自定义文案 = 最终提交说明（与 git rebase -i 编辑器语义一致）；
                // 未提供时沿用既有拼接语义（分组说明 + 本条说明）。
                match entry
                    .message
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    Some(custom) => last_group.message = custom.to_string(),
                    None => {
                        if !raw_msg.is_empty() {
                            if !last_group.message.is_empty() {
                                last_group.message.push_str("\n\n");
                            }
                            last_group.message.push_str(&raw_msg);
                        }
                    }
                }
            }
            RebaseAction::Fixup => {
                let Some(last_group) = groups.last_mut() else {
                    return Err(AppError::InvalidArg(
                        "最早一条提交不能设为 Fixup".to_string(),
                    ));
                };
                last_group.last_id = oid;
            }
            RebaseAction::Drop => {
                return Err(AppError::InvalidArg(
                    "丢弃（Drop）仅在交互式变基路径中支持".to_string(),
                ));
            }
        }
    }

    let committer = commit_signature(repo)?;
    let mut parent_oid = base_parent_id;
    let mut new_head_oid = None;

    for group in &groups {
        let base_commit = repo
            .find_commit(group.base_id)
            .map_err(|e| AppError::Git(format!("读取提交失败: {e}")))?;
        let last_commit = repo
            .find_commit(group.last_id)
            .map_err(|e| AppError::Git(format!("读取提交树源失败: {e}")))?;
        let tree = last_commit
            .tree()
            .map_err(|e| AppError::Git(format!("读取提交树失败: {e}")))?;
        let author = base_commit.author();
        let parent_commit = parent_oid
            .map(|id| repo.find_commit(id))
            .transpose()
            .map_err(|e| AppError::Git(format!("读取父提交失败: {e}")))?;
        let parent_refs: Vec<&git2::Commit<'_>> = parent_commit.iter().collect();

        let created = repo
            .commit(
                None,
                &author,
                &committer,
                &group.message,
                &tree,
                &parent_refs,
            )
            .map_err(|e| AppError::Git(format!("重写提交失败: {e}")))?;
        parent_oid = Some(created);
        new_head_oid = Some(created);
    }

    let final_oid =
        new_head_oid.ok_or_else(|| AppError::Unexpected("未生成新的 HEAD 提交".to_string()))?;
    let final_commit = repo
        .find_commit(final_oid)
        .map_err(|e| AppError::Git(format!("读取新 HEAD 提交失败: {e}")))?;

    repo.reset(final_commit.as_object(), git2::ResetType::Soft, None)
        .map_err(|e| AppError::Git(format!("更新分支指向新历史失败: {e}")))?;

    Ok(final_oid.to_string())
}
