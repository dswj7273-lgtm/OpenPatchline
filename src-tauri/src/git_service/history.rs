//! 提交历史分页遍历与过滤子模块。

use std::collections::HashMap;

use crate::error::{AppError, AppResult};
use crate::types::{CommitNode, LogFilter, RefKind, RefLabel};

/// message 子串匹配的扫描窗口（字节，截断到字符边界由 lossy 转换兜底）。
const MESSAGE_MATCH_LIMIT: usize = 64 * 1024;

/// 分页读取提交历史（newest-first），并填充引用标签。
pub fn load_commit_page(
    repo: &git2::Repository,
    cursor: Option<&str>,
    limit: usize,
    filter: Option<&LogFilter>,
) -> AppResult<(Vec<CommitNode>, bool)> {
    let filter = filter.cloned().unwrap_or_default();
    let cursor_oid = match cursor {
        Some(c) => Some(
            git2::Oid::from_str(c)
                .map_err(|e| AppError::InvalidArg(format!("cursor 非法: {c} ({e})")))?,
        ),
        None => None,
    };

    let mut walk = repo
        .revwalk()
        .map_err(|e| AppError::Git(format!("创建 revwalk 失败: {e}")))?;
    // 拓扑序（父在子后），时间作并列时的次序参考。
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| AppError::Git(format!("设置遍历排序失败: {e}")))?;
    match filter.branch.as_deref() {
        Some(branch) => {
            let start = resolve_start(repo, branch)?;
            walk.push(start)
                .map_err(|e| AppError::Git(format!("从 {branch} 开始遍历失败: {e}")))?;
        }
        None => walk.push_head().map_err(|e| {
            AppError::NotFound(format!("HEAD 不可用（空仓库？），无法读取提交历史: {e}"))
        })?,
    }

    let ref_labels = collect_ref_labels(repo)?;

    let mut nodes: Vec<CommitNode> = Vec::new();
    let mut has_more = false;
    let mut seen_cursor = cursor_oid.is_none();
    for oid in walk {
        let oid = oid.map_err(|e| AppError::Git(format!("遍历提交历史失败: {e}")))?;
        if !seen_cursor {
            if Some(oid) == cursor_oid {
                seen_cursor = true;
            }
            continue;
        }
        let commit = repo
            .find_commit(oid)
            .map_err(|e| AppError::Git(format!("读取提交 {oid} 失败: {e}")))?;
        if !passes_filter(&commit, &filter) {
            continue;
        }
        if nodes.len() == limit {
            has_more = true;
            break;
        }
        nodes.push(commit_to_node(&commit, &ref_labels));
    }
    Ok((nodes, has_more))
}

/// 解析遍历起点：分支名先查本地再查远程，最后按完整引用名兜底。
fn resolve_start(repo: &git2::Repository, branch: &str) -> AppResult<git2::Oid> {
    for ty in [git2::BranchType::Local, git2::BranchType::Remote] {
        if let Ok(found) = repo.find_branch(branch, ty)
            && let Ok(commit) = found.get().peel_to_commit()
        {
            return Ok(commit.id());
        }
    }
    let reference = repo
        .find_reference(branch)
        .map_err(|_| AppError::NotFound(format!("分支或引用不存在: {branch}")))?;
    let commit = reference
        .peel_to_commit()
        .map_err(|e| AppError::NotFound(format!("引用 {branch} 不指向提交: {e}")))?;
    Ok(commit.id())
}

/// 收集 commit-id → 引用标签表（本地/远程分支、标签、HEAD 当前分支）。
fn collect_ref_labels(repo: &git2::Repository) -> AppResult<HashMap<git2::Oid, Vec<RefLabel>>> {
    let mut map: HashMap<git2::Oid, Vec<RefLabel>> = HashMap::new();
    let references = repo
        .references()
        .map_err(|e| AppError::Git(format!("枚举引用失败: {e}")))?;
    for entry in references {
        let reference = entry.map_err(|e| AppError::Git(format!("枚举引用失败: {e}")))?;
        let Ok(name) = reference.name() else {
            continue;
        };
        let (short, kind) = if let Some(s) = name.strip_prefix("refs/heads/") {
            (s, RefKind::Local)
        } else if let Some(s) = name.strip_prefix("refs/remotes/") {
            (s, RefKind::Remote)
        } else if let Some(s) = name.strip_prefix("refs/tags/") {
            (s, RefKind::Tag)
        } else {
            continue;
        };
        if let Ok(commit) = reference.peel_to_commit() {
            map.entry(commit.id()).or_default().push(RefLabel {
                name: short.to_string(),
                kind,
            });
        }
    }
    if let Ok(head) = repo.head()
        && head.is_branch()
        && let (Ok(name), Ok(commit)) = (head.shorthand(), head.peel_to_commit())
    {
        map.entry(commit.id()).or_default().push(RefLabel {
            name: name.to_string(),
            kind: RefKind::Head,
        });
    }
    Ok(map)
}

/// 过滤条件：author / query / since / until。
fn passes_filter(commit: &git2::Commit<'_>, filter: &LogFilter) -> bool {
    if let Some(author) = filter.author.as_deref() {
        let needle = author.to_lowercase();
        let sig = commit.author();
        let name = sig.name().unwrap_or_default().to_lowercase();
        let email = sig.email().unwrap_or_default().to_lowercase();
        if !name.contains(&needle) && !email.contains(&needle) {
            return false;
        }
    }
    if let Some(query) = filter.query.as_deref() {
        let needle = query.to_lowercase();
        let message = commit.message().unwrap_or_default();
        let cap = message.len().min(MESSAGE_MATCH_LIMIT);
        let head = String::from_utf8_lossy(&message.as_bytes()[..cap]).to_lowercase();
        if !head.contains(&needle) {
            return false;
        }
    }
    let time = commit.time().seconds();
    if let Some(since) = filter.since
        && time < since
    {
        return false;
    }
    if let Some(until) = filter.until
        && time > until
    {
        return false;
    }
    true
}

/// `git2::Commit` → `CommitNode`（lane/lane_color 保持 0，由 graph 模块填充）。
fn commit_to_node(
    commit: &git2::Commit<'_>,
    ref_labels: &HashMap<git2::Oid, Vec<RefLabel>>,
) -> CommitNode {
    let id = commit.id().to_string();
    let subject = commit
        .message()
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let author = commit.author();
    CommitNode {
        short_id: id.chars().take(7).collect(),
        id,
        message: subject,
        author_name: author.name().unwrap_or_default().to_string(),
        author_email: author.email().unwrap_or_default().to_string(),
        timestamp: commit.time().seconds(),
        parent_ids: commit.parent_ids().map(|oid| oid.to_string()).collect(),
        refs: ref_labels.get(&commit.id()).cloned().unwrap_or_default(),
        lane: 0,
        lane_color: 0,
    }
}
