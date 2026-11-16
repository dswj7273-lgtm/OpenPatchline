//! Git Service：封装所有 git2-rs 本地仓库操作的高层 API（docs/04-git-engine.md）。
//!
//! 约定：
//! - 仓库实例由 repo_manager 持有并传入，本模块不管理仓库生命周期；
//! - 只做本地操作，不触碰网络；
//! - 所有错误经 [`AppResult`] 返回，禁止 unwrap。

use std::collections::HashMap;
use std::path::Path;

use crate::diff_engine::{self, DiffOptions as TextDiffOptions};
use crate::error::{AppError, AppResult};
use crate::types::{
    BranchInfo, BranchKind, ChangeType, ChangedFile, ChildRepo, CommitNode, FileDiffResult,
    FileStatus, LogFilter, RefKind, RefLabel, RepoInfo, RepoState,
};

/// 二进制内容嗅探窗口（字节）：前 8KB 出现 NUL 即视为二进制。
const BINARY_SNIFF_LEN: usize = 8192;
/// 单文件 diff 大小保护阈值：old + new 总字节数超过则置 `too_large`。
const MAX_DIFF_BYTES: usize = 10 * 1024 * 1024;
/// 单文件 diff 行数保护阈值：old + new 总行数超过则置 `too_large`。
const MAX_DIFF_LINES: usize = 100_000;
/// message 子串匹配的扫描窗口（字节，截断到字符边界由 lossy 转换兜底）。
const MESSAGE_MATCH_LIMIT: usize = 64 * 1024;
/// find_similar 的重命名/复制相似度阈值（百分比）。
const SIMILARITY_THRESHOLD: u16 = 50;
/// 提交签名回退用户名（仓库与全局配置、$USER 均缺失时）。
const FALLBACK_SIGNATURE_NAME: &str = "OpenPatchline";
/// 提交签名回退邮箱。
const FALLBACK_SIGNATURE_EMAIL: &str = "openpatchline@local";

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
        // 空仓库（unborn HEAD）：head_branch None、head_commit 空字符串。
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

/// 分页读取提交历史（newest-first），并填充引用标签。
///
/// - `cursor`：上一页最后一条 commit 的 id，从其继续向更早方向遍历（不含自身）；
///   None 时从 `filter.branch` 指定的引用（默认 HEAD）开始 revwalk；
/// - `limit`：本页目标条数；实现应多取一条探测 `has_more`；
/// - `filter`：revwalk 起点之后做过滤——author 匹配作者名/邮箱子串，
///   query 匹配 message 子串，since/until 为 Unix 时间戳（秒）边界；
/// - refs：遍历本地/远程引用与标签，把指向各 commit 的引用收集为
///   `RefLabel`（HEAD 解析出的当前分支标记为 `RefKind::Head`）。
///
/// 返回 `(commits, has_more)`；每个 `CommitNode` 的 lane/lane_color 保持
/// 默认 0，由 graph 模块后续填充。根提交的 `parent_ids` 为空。
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
            // 已取满一页且还能找到下一条符合过滤条件的提交。
            has_more = true;
            break;
        }
        nodes.push(commit_to_node(&commit, &ref_labels));
    }
    Ok((nodes, has_more))
}

/// 某次提交相对其第一个父提交的变更文件列表。
///
/// - 根提交与空树做 diff；
/// - 开启 rename 检测（find_similar）：重命名时 `path` 为新路径、`old_path` 为原路径；
/// - delta → `ChangeType`：Modified / Added / Deleted / Renamed；
///   任一侧内容为二进制时标记 Binary（additions/deletions 记 0）；
/// - additions/deletions 来自各文件 patch 统计。
pub fn changed_files(repo: &git2::Repository, commit_id: &str) -> AppResult<Vec<ChangedFile>> {
    let commit = find_commit(repo, commit_id)?;
    let new_tree = commit
        .tree()
        .map_err(|e| AppError::Git(format!("读取提交树失败: {e}")))?;
    let parent_tree = first_parent_tree(&commit)?;

    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0);
    let mut diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))
        .map_err(|e| AppError::Git(format!("计算提交 {commit_id} 的 diff 失败: {e}")))?;
    find_similar(&mut diff)?;

    let mut files = Vec::with_capacity(diff.deltas().len());
    for (idx, delta) in diff.deltas().enumerate() {
        let new_path = path_str(delta.new_file().path());
        let old_path = path_str(delta.old_file().path());
        let path = new_path
            .clone()
            .or(old_path.clone())
            .ok_or_else(|| AppError::InvalidArg("diff delta 缺少路径".to_string()))?;

        // 二进制：delta 标记或两侧 blob 前 8KB NUL 嗅探。
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
        // 逐文件行统计（context, additions, deletions）。
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
///
/// 取两侧 tree 中 `path` 对应的 blob 文本交给 diff_engine 计算；文本按 UTF-8
/// 处理，二进制内容置 `is_binary` 且 `rows` 为空；超过大小/行数阈值置
/// `too_large` 并截断（docs/05 §8）。重命名时 `old_path`/`new_path` 不同。
/// 统计数据（additions/deletions/change_row_indices）由 diff_engine 派生。
pub fn file_diff_commit(
    repo: &git2::Repository,
    commit_id: &str,
    path: &str,
) -> AppResult<FileDiffResult> {
    let commit = find_commit(repo, commit_id)?;
    let new_tree = commit
        .tree()
        .map_err(|e| AppError::Git(format!("读取提交树失败: {e}")))?;
    let parent_tree = first_parent_tree(&commit)?;

    let (status, old_path, new_path) =
        tree_delta_info(repo, parent_tree.as_ref(), Some(&new_tree), path)?;
    let old = if status == git2::Delta::Added {
        None
    } else {
        blob_bytes_from_tree(
            repo,
            parent_tree.as_ref(),
            old_path.as_deref().unwrap_or(path),
        )?
    };
    let new = if status == git2::Delta::Deleted {
        None
    } else {
        blob_bytes_from_tree(repo, Some(&new_tree), new_path.as_deref().unwrap_or(path))?
    };
    let change_type = delta_change_type(status).unwrap_or(ChangeType::Modified);
    Ok(build_file_diff(old, new, old_path, new_path, change_type))
}

/// 暂存区中单个文件的 diff：HEAD blob vs index blob。
///
/// 新增文件（HEAD 中不存在）old 侧为空、全部为 Added；删除文件反之。
/// 重命名文件按配对后的两侧路径取内容（HEAD 旧路径 vs index 新路径）。
/// 二进制 / 大文件保护同 [`file_diff_commit`]。
pub fn file_diff_staged(repo: &git2::Repository, path: &str) -> AppResult<FileDiffResult> {
    let head_tree = head_tree(repo)?;
    let index = repo
        .index()
        .map_err(|e| AppError::Git(format!("读取 index 失败: {e}")))?;

    // 不用 pathspec 限定范围（会拆散重命名配对，见 [`find_delta`]），
    // 全量 diff 后按路径定位目标 delta。
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0);
    let mut diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))
        .map_err(|e| AppError::Git(format!("计算 {path} 的暂存 diff 失败: {e}")))?;
    find_similar(&mut diff)?;
    // status() 对暂存重命名按旧路径上报，因此优先按旧路径匹配。
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
///
/// untracked 文件整体作为新增（old 侧为空）；工作区已删除的文件整体作为
/// 删除。未暂存的重命名按配对后的两侧路径取内容（index 旧路径 vs 工作区
/// 新路径）。其余语义同 [`file_diff_commit`]。
pub fn file_diff_workdir(repo: &git2::Repository, path: &str) -> AppResult<FileDiffResult> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
    let index = repo
        .index()
        .map_err(|e| AppError::Git(format!("读取 index 失败: {e}")))?;
    let head_tree = head_tree(repo)?;

    // index→workdir diff（含未跟踪文件与重命名检测）定位真实 delta：
    // status() 对未暂存重命名只按旧路径上报，另一侧是新路径，必须用
    // 配对结果取两侧内容。
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0).include_untracked(true);
    let mut diff = repo
        .diff_index_to_workdir(Some(&index), Some(&mut opts))
        .map_err(|e| AppError::Git(format!("计算 {path} 的工作区 diff 失败: {e}")))?;
    find_similar(&mut diff)?;
    // 与 status() 一致：优先按旧路径（index 侧）匹配。
    let (status, old_path, new_path) = match find_delta(diff.deltas(), path, false) {
        Some(delta) => (
            Some(delta.status()),
            path_str(delta.old_file().path()),
            path_str(delta.new_file().path()),
        ),
        // delta 未命中（工作区无该文件变更）：两侧按原路径对比，
        // 结果为全上下文行的空 diff。
        None => (None, Some(path.to_string()), Some(path.to_string())),
    };

    // old 侧：index 优先（重命名时为旧路径），不在 index（untracked）则回退 HEAD。
    let old_lookup = old_path.as_deref().unwrap_or(path);
    let old = match blob_bytes_from_index(repo, &index, old_lookup)? {
        Some(bytes) => Some(bytes),
        None => blob_bytes_from_tree(repo, head_tree.as_ref(), old_lookup)?,
    };
    // new 侧：工作区文件（重命名时为新路径）；磁盘上不存在（已删除）按 None 处理。
    let new_lookup = new_path.as_deref().unwrap_or(path);
    let new = match std::fs::read(workdir.join(new_lookup)) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(AppError::Io(format!("读取工作区文件 {path} 失败: {e}"))),
    };

    let change_type = match status.and_then(delta_change_type) {
        // 纯 untracked（old 侧为空）：与新增一致，整体 Added。
        Some(ChangeType::Untracked) if old.is_none() => ChangeType::Added,
        Some(
            t @ (ChangeType::Renamed
            | ChangeType::Modified
            | ChangeType::Added
            | ChangeType::Deleted),
        ) => t,
        // delta 未命中、状态无法归类（如冲突）或 old 侧非空的 Untracked
        // 边角（staged 删除后又在工作区重建）：按两侧内容推断。
        _ => match (&old, &new) {
            (None, Some(_)) => ChangeType::Added,
            (Some(_), None) => ChangeType::Deleted,
            _ => ChangeType::Modified,
        },
    };
    Ok(build_file_diff(old, new, old_path, new_path, change_type))
}

/// 查询工作区状态：staged（index vs HEAD）与 unstaged（workdir vs index）。
///
/// - 未跟踪文件：`staged == None` 且 `unstaged == Some(Untracked)`；
/// - 同一文件两侧都有变更时两栏均有值（如部分暂存）；
/// - untracked 目录递归展开到文件级。
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

/// 暂存单个文件（Stage）。
///
/// 将工作区文件写入 index（`index.add_path`）；若文件在工作区已被删除，
/// 则从 index 移除该路径（`index.remove_path`），最后写回 index。
/// 若路径处于冲突状态，同时清除 stage 1/2/3 冲突条目（等价于 `git add <path>` / 标记已解决）。
pub fn stage_file(repo: &mut git2::Repository, path: &str) -> AppResult<()> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?;
    let mut index = repo
        .index()
        .map_err(|e| AppError::Git(format!("读取 index 失败: {e}")))?;

    let rel = Path::new(path);
    let full = workdir.join(rel);
    if full.is_dir() {
        // 目录：`git add <dir>` 语义 —— add_all 收新文件与修改，update_all
        // 收删除（把已暂存目录里被删掉的文件同步移出 index）。
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
///
/// 把该路径的 index 条目重置回 HEAD 树（`reset_default` 到 HEAD）；
/// HEAD 中不存在的新文件则直接从 index 删除条目。
pub fn unstage_file(repo: &mut git2::Repository, path: &str) -> AppResult<()> {
    match head_commit(repo)? {
        Some(head) => {
            repo.reset_default(Some(head.as_object()), [path])
                .map_err(|e| AppError::Git(format!("重置 {path} 到 HEAD 失败: {e}")))?;
        }
        None => {
            // unborn HEAD：没有可回退的树，直接从 index 删除条目。
            let mut index = repo
                .index()
                .map_err(|e| AppError::Git(format!("读取 index 失败: {e}")))?;
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

/// 将当前 index 内容创建为一个提交，返回新提交 id。
///
/// - 树取 `index.write_tree`；签名优先取仓库配置 `repo.signature()`，
///   缺失时回退到内置默认签名（如 "OpenPatchline <openpatchline@local>"）；
/// - 父提交为 HEAD；无 HEAD（空仓库首提交）时无父；
/// - 合并进行中（存在 MERGE_HEAD，如冲突 pull 解决后提交）：把
///   MERGE_HEAD 记为第二父提交，并在提交成功后清除 MERGE_HEAD /
///   MERGE_MSG / MERGE_MODE，收尾合并（与 git CLI 行为一致，libgit2
///   不会自动清理）；
///   提交后更新 HEAD（处于分支上时更新分支引用，分离 HEAD 时移动 HEAD）。
pub fn create_commit(repo: &mut git2::Repository, message: &str) -> AppResult<String> {
    if repo_state(repo) == RepoState::Rebasing {
        return Err(AppError::InvalidArg(
            "正在进行 Rebase，请解决冲突并暂存后使用「继续」完成变基".to_string(),
        ));
    }
    let signature = commit_signature(repo)?;
    let mut index = repo
        .index()
        .map_err(|e| AppError::Git(format!("读取 index 失败: {e}")))?;
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

    // 合并进行中：MERGE_HEAD 作为第二父提交。
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

    // 提交成功后收尾合并 / cherry-pick / revert 状态文件（libgit2 不会自动清理）。
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

/// 列出本地与远程分支（本地在前，各组内按名称排序）。
///
/// - 本地分支附带上游跟踪信息与 ahead/behind 计数（`graph_ahead_behind`，
///   无上游时均为 None）；
/// - HEAD 当前分支标记 `is_current`（分离 HEAD 时无当前分支）；
/// - 远程分支的符号引用（如 `origin/HEAD`）跳过；
/// - 空仓库（unborn HEAD）返回空列表。
pub fn list_branches(repo: &git2::Repository) -> AppResult<Vec<BranchInfo>> {
    // 当前分支短名（分支头才有；分离 HEAD / unborn 均为 None）。
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
        // 符号引用（origin/HEAD 等）不是可检出的分支，跳过。
        if branch.get().symbolic_target().ok().flatten().is_some() {
            continue;
        }
        let Some(name) = branch.name().ok().flatten().map(str::to_string) else {
            continue; // 非 UTF-8 分支名
        };
        let commit = branch
            .get()
            .peel_to_commit()
            .map_err(|e| AppError::Git(format!("解析分支 {name} 顶端提交失败: {e}")))?;

        match branch_type {
            git2::BranchType::Local => {
                let is_current = head_name.as_deref() == Some(name.as_str());
                // 上游跟踪：读取 branch.<name>.remote/merge 配置并计算领先/落后。
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

/// 切换分支（checkout）。
///
/// - `name` 为本地分支：SAFE 策略检出（保留不冲突的本地修改，
///   会覆盖的修改则报错），再把 HEAD 指向 `refs/heads/<name>`；
/// - `name` 为远程分支（如 `origin/dev`；远程名含 `/` 时按已配置远程
///   最长前缀匹配拆分，见 [`split_remote_branch`]）：
///   - 同名本地短分支（`dev`）已存在 → 切换到该本地分支；
///   - 不存在 → 检出成功后从远程分支创建本地跟踪分支
///     （`branch.<name>.remote/merge` 已配置），等价于 `git checkout dev`
///     的 DWIM 行为——分支与配置只在检出成功后落盘，失败不残留
///     （与 git CLI 一致）；
/// - 分支不存在报 [`AppError::NotFound`]；检出冲突报 [`AppError::Git`]
///   （消息含 libgit2 的冲突文件说明）。
pub fn checkout_branch(repo: &mut git2::Repository, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidArg("分支名不能为空".to_string()));
    }
    if !git2::Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(AppError::InvalidArg(format!("非法分支名: {name}")));
    }

    /// 检出目标：既有本地分支，或待创建的远程跟踪分支。
    enum Target {
        /// 切到 refs/heads/<name>。
        Local(String),
        /// 检出 origin 侧提交，成功后创建本地跟踪分支 <short>。
        CreateTracking { short: String },
    }

    let target = if repo.find_branch(name, git2::BranchType::Local).is_ok() {
        Target::Local(name.to_string())
    } else if repo.find_branch(name, git2::BranchType::Remote).is_ok() {
        // 远程分支：按已配置远程做最长前缀匹配拆出（远程名，本地短名）。
        // 远程名本身可含 '/'（如 my/remote），不能简单按首段拆分。
        let (_remote_name, short) = split_remote_branch(repo, name)?;
        if repo.find_branch(&short, git2::BranchType::Local).is_ok() {
            // 本地短分支已存在：切换到它（与 git checkout <short> 一致）。
            Target::Local(short)
        } else {
            Target::CreateTracking { short }
        }
    } else {
        return Err(AppError::NotFound(format!("分支不存在: {name}")));
    };

    // 解析目标提交（本地分支 → refs/heads/<name>；DWIM → 远程分支名），
    // 先检出其树（SAFE：默认拒绝覆盖未提交修改）。DWIM 的分支与跟踪
    // 配置留到检出成功后再创建，避免失败残留。树在块作用域内释放，
    // 之后的 create_tracking_branch 才能 `&mut` 借用 repo。
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

    // 检出成功：DWIM 场景先创建本地跟踪分支（含跟踪配置），再移动 HEAD。
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

/// 读取 refs/heads/<branch> 顶端提交的树。
fn branch_tree<'r>(repo: &'r git2::Repository, branch: &str) -> AppResult<git2::Tree<'r>> {
    repo.find_reference(&format!("refs/heads/{branch}"))
        .or_else(|_| repo.find_reference(&format!("refs/remotes/{branch}")))
        .map_err(|e| AppError::NotFound(format!("分支不存在: {branch} ({e})")))?
        .peel_to_commit()
        .map_err(|e| AppError::Git(format!("解析分支 {branch} 顶端提交失败: {e}")))?
        .tree()
        .map_err(|e| AppError::Git(format!("读取分支 {branch} 树失败: {e}")))
}

/// 从远程跟踪分支 `<remote_ref>`（如 `origin/dev`）创建本地分支
/// `<short>` 并写入跟踪配置。
///
/// 跟踪配置手动写（branch.<name>.remote/merge）：libgit2 的
/// `set_upstream` 会把 merge 写成 refs/remotes/…，git CLI 的
/// pull 不识别；标准写法与 `git checkout --track` 一致。
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

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/// 按 id 查找提交；id 非法报 InvalidArg，不存在报 NotFound。
fn find_commit<'r>(repo: &'r git2::Repository, commit_id: &str) -> AppResult<git2::Commit<'r>> {
    let oid = git2::Oid::from_str(commit_id)
        .map_err(|e| AppError::InvalidArg(format!("commit id 非法: {commit_id} ({e})")))?;
    repo.find_commit(oid)
        .map_err(|e| AppError::NotFound(format!("提交不存在: {commit_id} ({e})")))
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

/// 从远程跟踪分支短名拆出 (远程名, 本地短名)。
///
/// 按已配置远程做**最长前缀**匹配：远程名本身可含 `/`
/// （`my/remote/dev` → (`my/remote`, `dev`)），且 `my/remote` 必须先于
/// `my` 命中；没有任何远程匹配时报 [`AppError::InvalidArg`]。
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
            // 远程分支保留完整短名（如 origin/main）。
            (s, RefKind::Remote)
        } else if let Some(s) = name.strip_prefix("refs/tags/") {
            (s, RefKind::Tag)
        } else {
            continue; // HEAD 等符号引用单独处理
        };
        // 标签可能指向 tag 对象，peel 到 commit；非 commit 目标跳过。
        if let Ok(commit) = reference.peel_to_commit() {
            map.entry(commit.id()).or_default().push(RefLabel {
                name: short.to_string(),
                kind,
            });
        }
    }
    // HEAD 当前分支标记。
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

/// 过滤条件：author（名字/邮箱子串，忽略大小写）、query（message 子串，
/// 只扫描前 64KB）、since/until（提交时间，秒，闭区间）。
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
        // lossy 转换保证字节截断不会 panic（边界字符退化为替换符）。
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

/// HEAD 提交；空仓库（unborn HEAD）返回 None。
fn head_commit(repo: &git2::Repository) -> AppResult<Option<git2::Commit<'_>>> {
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
fn head_tree(repo: &git2::Repository) -> AppResult<Option<git2::Tree<'_>>> {
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

/// 提交第一个父提交的树；根提交返回 None（与空树 diff 等价）。
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

/// 计算两棵树的全量 diff（含重命名检测）后按路径定位目标文件，
/// 返回该文件的 (delta 状态, 旧路径, 新路径)。
///
/// 不用 pathspec 限定范围：重命名配对的两侧路径不同，pathspec 只会留下
/// 半边 delta（重命名退化成 Added/Deleted），见 [`find_delta`]。
fn tree_delta_info(
    repo: &git2::Repository,
    old_tree: Option<&git2::Tree<'_>>,
    new_tree: Option<&git2::Tree<'_>>,
    path: &str,
) -> AppResult<(git2::Delta, Option<String>, Option<String>)> {
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0);
    let mut diff = repo
        .diff_tree_to_tree(old_tree, new_tree, Some(&mut opts))
        .map_err(|e| AppError::Git(format!("计算 {path} 的 diff 失败: {e}")))?;
    find_similar(&mut diff)?;
    // changed_files 以新路径上报重命名条目，因此优先按新路径匹配。
    let delta = find_delta(diff.deltas(), path, true)
        .ok_or_else(|| AppError::NotFound(format!("文件 {path} 在该提交中无变更")))?;
    Ok((
        delta.status(),
        path_str(delta.old_file().path()),
        path_str(delta.new_file().path()),
    ))
}

/// 在 diff 的 deltas 中按路径定位目标 delta：先按优先侧精确匹配，命中即返回；
/// 只命中另一侧的重命名 delta 记为候选，遍历结束再回退。
///
/// - `prefer_new`：优先匹配新路径（`changed_files`/前端 diff 文件列表以新路径
///   上报重命名条目）；
/// - 否则优先匹配旧路径（`status` 对暂存/未暂存重命名按旧路径上报）；
/// - 普通 delta（Added/Deleted/Modified）两侧路径相同，任一优先侧都直接命中。
fn find_delta<'d>(
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

/// 对 diff 开启重命名/复制检测（相似度阈值 50）。
///
/// `for_untracked`：index→workdir diff 中把未跟踪文件纳入重命名目标
/// （与 status 的 `renames_index_to_workdir` 行为一致）；对 tree diff 无影响。
fn find_similar(diff: &mut git2::Diff<'_>) -> AppResult<()> {
    let mut opts = git2::DiffFindOptions::new();
    opts.renames(true)
        .copies(true)
        .for_untracked(true)
        .rename_threshold(SIMILARITY_THRESHOLD);
    diff.find_similar(Some(&mut opts))
        .map_err(|e| AppError::Git(format!("重命名检测失败: {e}")))
}

/// `git2::Delta` → `ChangeType`；无法归类（Unmodified/Ignored 等）返回 None。
fn delta_change_type(status: git2::Delta) -> Option<ChangeType> {
    match status {
        git2::Delta::Added => Some(ChangeType::Added),
        git2::Delta::Deleted => Some(ChangeType::Deleted),
        git2::Delta::Renamed | git2::Delta::Copied => Some(ChangeType::Renamed),
        git2::Delta::Modified | git2::Delta::Typechange => Some(ChangeType::Modified),
        git2::Delta::Untracked => Some(ChangeType::Untracked),
        _ => None,
    }
}

/// 读取树中指定路径 blob 的原始字节；路径不存在或非 blob（子树等）返回 None。
fn blob_bytes_from_tree(
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

/// 读取 index 中指定路径（stage 0）blob 的原始字节；不在 index 返回 None。
fn blob_bytes_from_index(
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

/// 由两侧原始内容构建 [`FileDiffResult`]：二进制嗅探 → 大小保护 → 文本 diff。
fn build_file_diff(
    old: Option<Vec<u8>>,
    new: Option<Vec<u8>>,
    old_path: Option<String>,
    new_path: Option<String>,
    change_type: ChangeType,
) -> FileDiffResult {
    // 二进制：任一侧前 8KB 出现 NUL 字节。
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

/// 前 8192 字节中是否出现 NUL（二进制判定）。
fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_LEN).any(|&b| b == 0)
}

/// blob id（非零时）内容是否为二进制；读取失败按非二进制处理。
fn is_binary_blob(repo: &git2::Repository, oid: git2::Oid) -> bool {
    if oid.is_zero() {
        return false;
    }
    match repo.find_blob(oid) {
        Ok(blob) => is_binary_bytes(blob.content()),
        Err(_) => false,
    }
}

/// `&Path` → 展示用字符串。
fn path_str(p: Option<&Path>) -> Option<String> {
    p.map(|p| p.to_string_lossy().into_owned())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::LineKind;

    /// 固定测试签名，避免依赖机器上的全局 git 配置。
    fn sig() -> git2::Signature<'static> {
        git2::Signature::now("Test User", "test@example.com").expect("构造签名失败")
    }

    /// 初始化临时仓库，并把 user.name/user.email 写入仓库本地配置，
    /// 使 `repo.signature()` 确定性可用。
    fn init_repo() -> (tempfile::TempDir, git2::Repository) {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let repo = git2::Repository::init(dir.path()).expect("初始化仓库失败");
        let mut config = repo.config().expect("读取仓库配置失败");
        config
            .set_str("user.name", "Test User")
            .expect("设置 user.name 失败");
        config
            .set_str("user.email", "test@example.com")
            .expect("设置 user.email 失败");
        (dir, repo)
    }

    /// 写入工作区文件、加入 index 并提交（覆盖式），返回新提交 id。
    fn commit_file(repo: &git2::Repository, path: &str, content: &str, message: &str) -> String {
        let file_path = repo.workdir().expect("仓库应有工作区").join(path);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).expect("创建目录失败");
        }
        std::fs::write(&file_path, content).expect("写入文件失败");

        let mut index = repo.index().expect("读取 index 失败");
        index.add_path(Path::new(path)).expect("add_path 失败");
        index.write().expect("写回 index 失败");
        let tree_oid = index.write_tree_to(repo).expect("write_tree 失败");
        let tree = repo.find_tree(tree_oid).expect("find_tree 失败");
        let parents: Vec<git2::Commit<'_>> = match repo.head() {
            Ok(head) => vec![head.peel_to_commit().expect("解析 HEAD 失败")],
            Err(_) => Vec::new(),
        };
        let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
        let oid = repo
            .commit(Some("HEAD"), &sig(), &sig(), message, &tree, &parent_refs)
            .expect("创建提交失败");
        oid.to_string()
    }

    /// 按 path 查找状态条目。
    fn find_status<'a>(statuses: &'a [FileStatus], path: &str) -> Option<&'a FileStatus> {
        statuses.iter().find(|s| s.path == path)
    }

    /// 子仓库扫描：只返回含 .git 的直接子目录，按名称排序；忽略普通目录与文件。
    #[test]
    fn list_child_repos_finds_direct_children_only() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        // 两个仓库 + 一个普通目录 + 一个普通文件 + 一个嵌套仓库（不应被发现）。
        for name in ["z-repo", "a-repo"] {
            git2::Repository::init(dir.path().join(name)).expect("初始化子仓库失败");
        }
        std::fs::create_dir_all(dir.path().join("plain-dir/nested-repo")).expect("创建目录失败");
        git2::Repository::init(dir.path().join("plain-dir/nested-repo"))
            .expect("初始化嵌套仓库失败");
        std::fs::write(dir.path().join("file.txt"), "x").expect("写入文件失败");

        let repos = super::list_child_repos(dir.path());
        let names: Vec<&str> = repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["a-repo", "z-repo"], "仅一层子仓库，按名称排序");
        assert!(repos[0].path.ends_with("a-repo"));
    }

    /// (1) 线性 3 提交：每页 2 条 + cursor 续页，has_more 正确。
    #[test]
    fn commit_page_pagination() {
        let (_dir, repo) = init_repo();
        let c1 = commit_file(&repo, "a.txt", "v1\n", "commit 1");
        let c2 = commit_file(&repo, "a.txt", "v2\n", "commit 2");
        let c3 = commit_file(&repo, "a.txt", "v3\n", "commit 3");

        let (page1, has_more) = load_commit_page(&repo, None, 2, None).expect("读取第一页失败");
        assert!(has_more, "还剩 1 条提交，应有下一页");
        let ids: Vec<&str> = page1.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec![c3.as_str(), c2.as_str()]);

        // cursor = 第一页最后一条（c2），从其之后继续。
        let (page2, has_more2) =
            load_commit_page(&repo, Some(&c2), 2, None).expect("读取第二页失败");
        assert!(!has_more2, "历史已读完");
        let ids2: Vec<&str> = page2.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids2, vec![c1.as_str()]);
    }

    /// (2) 提交上的引用标签包含 Head 与 Local（分支名一致）。
    #[test]
    fn refs_labels_contain_head_and_branch() {
        let (_dir, repo) = init_repo();
        let head = commit_file(&repo, "a.txt", "v1\n", "initial");

        let info = repo_info(&repo).expect("repo_info 失败");
        assert_eq!(info.head_commit, head);
        assert!(info.head_branch.is_some());

        let (page, _) = load_commit_page(&repo, None, 10, None).expect("读取历史失败");
        assert_eq!(page.len(), 1);
        let branch_name = info.head_branch.expect("head_branch 应存在");
        let labels = &page[0].refs;
        assert!(
            labels
                .iter()
                .any(|l| l.name == branch_name && matches!(l.kind, RefKind::Head))
        );
        assert!(
            labels
                .iter()
                .any(|l| l.name == branch_name && matches!(l.kind, RefKind::Local))
        );
    }

    /// 构造“修改一行 + 新增一行”的两提交仓库，返回修改提交 id。
    fn modified_repo() -> (tempfile::TempDir, git2::Repository, String) {
        let (dir, repo) = init_repo();
        commit_file(&repo, "a.txt", "line1\nline2\n", "initial");
        let c2 = commit_file(&repo, "a.txt", "line1\nchanged\nline3\n", "modify");
        (dir, repo, c2)
    }

    /// (3) changed_files：Modified + 精确的 +/- 行数。
    #[test]
    fn changed_files_modified_counts() {
        let (_dir, repo, c2) = modified_repo();
        let files = changed_files(&repo, &c2).expect("changed_files 失败");
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "a.txt");
        assert!(f.old_path.is_none());
        assert!(matches!(f.change_type, ChangeType::Modified));
        assert_eq!(
            (f.additions, f.deletions),
            (2, 1),
            "新增 changed/line3，删除 line2"
        );
    }

    /// (4) file_diff_commit：修改行呈现为左 Removed / 右 Added 的行对。
    #[test]
    fn file_diff_commit_rows() {
        let (_dir, repo, c2) = modified_repo();
        let result = file_diff_commit(&repo, &c2, "a.txt").expect("file_diff_commit 失败");
        assert!(!result.is_binary);
        assert!(!result.too_large);
        assert!(matches!(result.change_type, ChangeType::Modified));
        assert_eq!((result.additions, result.deletions), (2, 1));

        let has_removed = result.rows.iter().any(|r| {
            r.left
                .as_ref()
                .is_some_and(|c| c.kind == LineKind::Removed && c.content == "line2")
        });
        let has_added = result.rows.iter().any(|r| {
            r.right
                .as_ref()
                .is_some_and(|c| c.kind == LineKind::Added && c.content == "changed")
        });
        assert!(has_removed, "左侧应出现 Removed 的 line2");
        assert!(has_added, "右侧应出现 Added 的 changed");
        assert!(!result.change_row_indices.is_empty());
    }

    /// (5) status：修改（unstaged）、暂存（staged）、未跟踪（Untracked）。
    #[test]
    fn status_staged_unstaged_untracked() {
        let (_dir, mut repo) = init_repo();
        commit_file(&repo, "a.txt", "v1\n", "initial");

        // 修改已跟踪文件 + 新增未跟踪文件。
        std::fs::write(
            repo.workdir().expect("工作区").join("a.txt"),
            "v1 modified\n",
        )
        .expect("写入失败");
        std::fs::write(repo.workdir().expect("工作区").join("new.txt"), "new\n").expect("写入失败");

        let statuses = status(&repo).expect("status 失败");
        let a = find_status(&statuses, "a.txt").expect("a.txt 应在状态中");
        assert!(matches!(a.unstaged, Some(ChangeType::Modified)));
        assert!(a.staged.is_none());
        let n = find_status(&statuses, "new.txt").expect("new.txt 应在状态中");
        assert!(matches!(n.unstaged, Some(ChangeType::Untracked)));
        assert!(n.staged.is_none());

        // 暂存后：a.txt 移到 staged 栏。
        stage_file(&mut repo, "a.txt").expect("stage 失败");
        let statuses = status(&repo).expect("status 失败");
        let a = find_status(&statuses, "a.txt").expect("a.txt 应在状态中");
        assert!(matches!(a.staged, Some(ChangeType::Modified)));
        assert!(a.unstaged.is_none());
    }

    /// 目录级暂存：stage_file 传目录路径时，目录下全部文件一次性进入暂存区。
    #[test]
    fn stage_directory_stages_all_inside() {
        let (_dir, mut repo) = init_repo();
        commit_file(&repo, "root.txt", "v1\n", "initial");

        let workdir = repo.workdir().expect("工作区").to_path_buf();
        std::fs::create_dir_all(workdir.join("feat/sub")).expect("创建目录失败");
        std::fs::write(workdir.join("feat/one.java"), "1\n").expect("写入失败");
        std::fs::write(workdir.join("feat/sub/two.java"), "2\n").expect("写入失败");

        let before = status(&repo).expect("状态失败");
        assert_eq!(
            before
                .iter()
                .filter(|s| s.unstaged == Some(ChangeType::Untracked))
                .count(),
            2,
            "两个新文件均未跟踪"
        );

        super::stage_file(&mut repo, "feat").expect("目录暂存失败");

        let after = status(&repo).expect("状态失败");
        for path in ["feat/one.java", "feat/sub/two.java"] {
            let entry = find_status(&after, path).expect("应出现在状态里");
            assert_eq!(entry.staged, Some(ChangeType::Added), "{path} 应已暂存");
            assert!(entry.unstaged.is_none(), "{path} 不应再有未暂存变更");
        }
    }

    /// (6) stage / unstage / create_commit 往返：提交 id 返回且出现在历史中。
    #[test]
    fn stage_unstage_commit_roundtrip() {
        let (_dir, mut repo) = init_repo();
        commit_file(&repo, "a.txt", "v1\n", "initial");

        // 修改 + 暂存。
        std::fs::write(repo.workdir().expect("工作区").join("a.txt"), "v2\n").expect("写入失败");
        stage_file(&mut repo, "a.txt").expect("stage 失败");
        let statuses = status(&repo).expect("status 失败");
        let a = find_status(&statuses, "a.txt").expect("a.txt 应在状态中");
        assert!(matches!(a.staged, Some(ChangeType::Modified)));

        // unstage：回到 unstaged。
        unstage_file(&mut repo, "a.txt").expect("unstage 失败");
        let statuses = status(&repo).expect("status 失败");
        let a = find_status(&statuses, "a.txt").expect("a.txt 应在状态中");
        assert!(a.staged.is_none());
        assert!(matches!(a.unstaged, Some(ChangeType::Modified)));

        // 新文件 stage 后 unstage：回到未跟踪。
        std::fs::write(repo.workdir().expect("工作区").join("b.txt"), "b\n").expect("写入失败");
        stage_file(&mut repo, "b.txt").expect("stage 失败");
        let statuses = status(&repo).expect("status 失败");
        assert!(matches!(
            find_status(&statuses, "b.txt")
                .expect("b.txt 应在状态中")
                .staged,
            Some(ChangeType::Added)
        ));
        unstage_file(&mut repo, "b.txt").expect("unstage 失败");
        let statuses = status(&repo).expect("status 失败");
        let b = find_status(&statuses, "b.txt").expect("b.txt 应在状态中");
        assert!(b.staged.is_none());
        assert!(matches!(b.unstaged, Some(ChangeType::Untracked)));

        stage_file(&mut repo, "a.txt").expect("stage 失败");
        let oid = create_commit(&mut repo, "second").expect("create_commit 失败");
        assert_eq!(oid.len(), 40);

        let (page, _) = load_commit_page(&repo, None, 10, None).expect("读取历史失败");
        assert_eq!(page.len(), 2, "initial + second 共 2 条提交");
        assert_eq!(page[0].id, oid);
        assert_eq!(page[0].message, "second");
        assert_eq!(page[0].short_id.len(), 7);

        // 提交后工作区干净（b.txt 仍未跟踪）。
        let statuses = status(&repo).expect("status 失败");
        assert!(find_status(&statuses, "a.txt").is_none());
        assert!(find_status(&statuses, "b.txt").is_some());
    }

    /// 磁盘上把 from 改名为 to（不动 index）。
    fn rename_on_disk(repo: &git2::Repository, from: &str, to: &str) {
        let workdir = repo.workdir().expect("仓库应有工作区");
        std::fs::rename(workdir.join(from), workdir.join(to)).expect("磁盘改名失败");
    }

    /// 把 to 的当前内容加入 index 并移除 from 的旧条目（git mv 的 index 效果），
    /// 返回改名提交（含磁盘改名）后的新提交 id。
    fn commit_rename(repo: &git2::Repository, from: &str, to: &str, message: &str) -> String {
        let mut index = repo.index().expect("读取 index 失败");
        index.remove_path(Path::new(from)).expect("移除旧路径失败");
        index.add_path(Path::new(to)).expect("加入新路径失败");
        index.write().expect("写回 index 失败");
        let tree_oid = index.write_tree_to(repo).expect("write_tree 失败");
        let tree = repo.find_tree(tree_oid).expect("find_tree 失败");
        let parents: Vec<git2::Commit<'_>> = vec![
            repo.head()
                .expect("读取 HEAD 失败")
                .peel_to_commit()
                .expect("解析 HEAD 失败"),
        ];
        let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
        let oid = repo
            .commit(Some("HEAD"), &sig(), &sig(), message, &tree, &parent_refs)
            .expect("创建提交失败");
        oid.to_string()
    }

    /// (7) 重命名提交：changed_files 按新路径上报，file_diff_commit（新路径查询）
    /// 返回配对后的 Renamed diff，而非整文件 Added。
    #[test]
    fn file_diff_commit_renamed() {
        let (_dir, repo) = init_repo();
        commit_file(&repo, "a.txt", "line1\nline2\nline3\n", "initial");

        // git mv a.txt b.txt 且顺手改一行。
        rename_on_disk(&repo, "a.txt", "b.txt");
        std::fs::write(
            repo.workdir().expect("工作区").join("b.txt"),
            "line1\nchanged\nline3\n",
        )
        .expect("写入失败");
        let c2 = commit_rename(&repo, "a.txt", "b.txt", "rename");

        let files = changed_files(&repo, &c2).expect("changed_files 失败");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "b.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("a.txt"));
        assert!(matches!(files[0].change_type, ChangeType::Renamed));

        let d = file_diff_commit(&repo, &c2, "b.txt").expect("file_diff_commit 失败");
        assert!(
            matches!(d.change_type, ChangeType::Renamed),
            "应为 Renamed，实际 {:?}",
            d.change_type
        );
        assert_eq!(d.old_path.as_deref(), Some("a.txt"));
        assert_eq!(d.new_path.as_deref(), Some("b.txt"));
        assert_eq!(
            (d.additions, d.deletions),
            (1, 1),
            "仅 line2 → changed 一对增删"
        );

        // 按旧路径查询也应定位到同一配对。
        let d_old = file_diff_commit(&repo, &c2, "a.txt").expect("file_diff_commit(旧路径) 失败");
        assert!(matches!(d_old.change_type, ChangeType::Renamed));
        assert_eq!(d_old.new_path.as_deref(), Some("b.txt"));
    }

    /// (8) 暂存重命名：status 按旧路径上报（b.txt 并入 rename 条目），
    /// file_diff_staged(旧路径) 返回配对后的 Renamed diff。
    #[test]
    fn file_diff_staged_renamed() {
        let (_dir, repo) = init_repo();
        commit_file(&repo, "a.txt", "line1\nline2\nline3\n", "initial");

        rename_on_disk(&repo, "a.txt", "b.txt");
        std::fs::write(
            repo.workdir().expect("工作区").join("b.txt"),
            "line1\nchanged\nline3\n",
        )
        .expect("写入失败");
        let mut index = repo.index().expect("读取 index 失败");
        index
            .remove_path(Path::new("a.txt"))
            .expect("移除旧路径失败");
        index.add_path(Path::new("b.txt")).expect("加入新路径失败");
        index.write().expect("写回 index 失败");

        let statuses = status(&repo).expect("status 失败");
        let entry = find_status(&statuses, "a.txt").expect("a.txt 应按旧路径上报暂存重命名");
        assert!(matches!(entry.staged, Some(ChangeType::Renamed)));

        let d = file_diff_staged(&repo, "a.txt").expect("file_diff_staged 失败");
        assert!(
            matches!(d.change_type, ChangeType::Renamed),
            "应为 Renamed，实际 {:?}",
            d.change_type
        );
        assert_eq!(d.old_path.as_deref(), Some("a.txt"));
        assert_eq!(d.new_path.as_deref(), Some("b.txt"));
        assert_eq!(
            (d.additions, d.deletions),
            (1, 1),
            "HEAD a.txt vs index b.txt 仅一对增删"
        );
    }

    /// (9) 未暂存重命名：status 按旧路径上报，file_diff_workdir(旧路径)
    /// 返回配对后的 Renamed diff（新侧取工作区新路径内容）。
    #[test]
    fn file_diff_workdir_renamed() {
        let (_dir, repo) = init_repo();
        commit_file(&repo, "a.txt", "line1\nline2\nline3\n", "initial");

        rename_on_disk(&repo, "a.txt", "b.txt");
        std::fs::write(
            repo.workdir().expect("工作区").join("b.txt"),
            "line1\nchanged\nline3\n",
        )
        .expect("写入失败");

        let statuses = status(&repo).expect("status 失败");
        let entry = find_status(&statuses, "a.txt").expect("a.txt 应按旧路径上报未暂存重命名");
        assert!(matches!(entry.unstaged, Some(ChangeType::Renamed)));

        let d = file_diff_workdir(&repo, "a.txt").expect("file_diff_workdir 失败");
        assert!(
            matches!(d.change_type, ChangeType::Renamed),
            "应为 Renamed，实际 {:?}",
            d.change_type
        );
        assert_eq!(d.old_path.as_deref(), Some("a.txt"));
        assert_eq!(d.new_path.as_deref(), Some("b.txt"));
        assert_eq!(
            (d.additions, d.deletions),
            (1, 1),
            "index a.txt vs 工作区 b.txt 仅一对增删"
        );
    }

    /// (10) 工作区普通场景回归（修改 / untracked / 删除 / 干净文件）。
    #[test]
    fn file_diff_workdir_plain_cases() {
        let (_dir, repo) = init_repo();
        commit_file(&repo, "a.txt", "v1\n", "initial");

        // 修改。
        std::fs::write(repo.workdir().expect("工作区").join("a.txt"), "v2\n").expect("写入失败");
        let d = file_diff_workdir(&repo, "a.txt").expect("modified diff 失败");
        assert!(matches!(d.change_type, ChangeType::Modified));
        assert_eq!((d.additions, d.deletions), (1, 1));
        assert_eq!(d.old_path.as_deref(), Some("a.txt"));
        assert_eq!(d.new_path.as_deref(), Some("a.txt"));

        // untracked：整体 Added。
        std::fs::write(repo.workdir().expect("工作区").join("new.txt"), "n\n").expect("写入失败");
        let d = file_diff_workdir(&repo, "new.txt").expect("untracked diff 失败");
        assert!(matches!(d.change_type, ChangeType::Added));
        assert_eq!((d.additions, d.deletions), (1, 0));

        // 删除。
        std::fs::remove_file(repo.workdir().expect("工作区").join("a.txt")).expect("删除失败");
        let d = file_diff_workdir(&repo, "a.txt").expect("deleted diff 失败");
        assert!(matches!(d.change_type, ChangeType::Deleted));
        assert_eq!((d.additions, d.deletions), (0, 1));

        // 干净文件：无工作区变更，返回无增删的 Modified diff。
        let (_dir2, repo2) = init_repo();
        commit_file(&repo2, "a.txt", "v1\n", "initial");
        let d = file_diff_workdir(&repo2, "a.txt").expect("clean diff 失败");
        assert!(matches!(d.change_type, ChangeType::Modified));
        assert_eq!((d.additions, d.deletions), (0, 0));
    }

    /// 配置名为 origin 的远程（指向占位 URL；libgit2 解析上游时校验
    /// remote 存在），并把 workdir 文件写入远程跟踪引用
    /// origin/<branch>（模拟 fetch 结果）。
    fn create_remote_ref(repo: &git2::Repository, branch: &str, commit_id: &str) {
        if repo.find_remote("origin").is_err() {
            repo.remote("origin", "https://example.com/openpatchline-test.git")
                .expect("配置 origin 远程失败");
        }
        let oid = git2::Oid::from_str(commit_id).expect("commit id 非法");
        repo.reference(&format!("refs/remotes/origin/{branch}"), oid, true, "test")
            .expect("创建远程跟踪引用失败");
    }

    /// 为本地分支配置上游（branch.<name>.remote / .merge）。
    fn set_upstream_config(repo: &git2::Repository, branch: &str) {
        let mut config = repo.config().expect("读取仓库配置失败");
        config
            .set_str(&format!("branch.{branch}.remote"), "origin")
            .expect("设置 remote 失败");
        config
            .set_str(
                &format!("branch.{branch}.merge"),
                &format!("refs/heads/{branch}"),
            )
            .expect("设置 merge 失败");
    }

    /// (11) list_branches：本地在前、当前分支标记、上游与 ahead/behind、
    /// 远程分支列出且跳过 origin/HEAD 符号引用。
    #[test]
    fn list_branches_current_upstream_and_remote() {
        let (_dir, repo) = init_repo();
        let c1 = commit_file(&repo, "a.txt", "v1\n", "initial");
        let main = repo
            .head()
            .expect("读取 HEAD 失败")
            .shorthand()
            .expect("HEAD 应为分支")
            .to_string();

        // dev 分支停在 c1；主线继续前进 → main 领先 dev。
        let tip = repo
            .find_commit(git2::Oid::from_str(&c1).expect("oid 非法"))
            .expect("查找提交失败");
        repo.branch("dev", &tip, false).expect("创建 dev 失败");
        let c2 = commit_file(&repo, "a.txt", "v2\n", "second");

        // 上游 origin/main 指向 c1（落后 1、领先 0）。
        create_remote_ref(&repo, &main, &c1);
        set_upstream_config(&repo, &main);
        // origin/HEAD 符号引用应被跳过。
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            &format!("refs/remotes/origin/{main}"),
            true,
            "test",
        )
        .expect("创建 origin/HEAD 失败");

        let branches = list_branches(&repo).expect("list_branches 失败");
        let names: Vec<(&str, BranchKind)> =
            branches.iter().map(|b| (b.name.as_str(), b.kind)).collect();
        // dev / main 本地在前（字典序），origin/main 远程在后。
        assert_eq!(
            names,
            vec![
                ("dev", BranchKind::Local),
                (main.as_str(), BranchKind::Local),
                (format!("origin/{main}").as_str(), BranchKind::Remote),
            ],
            "本地在前远程在后，origin/HEAD 符号引用跳过"
        );

        let main_info = branches
            .iter()
            .find(|b| b.name == main)
            .expect("应包含当前分支");
        assert!(main_info.is_current);
        assert_eq!(
            main_info.upstream.as_deref(),
            Some(format!("origin/{main}").as_str())
        );
        assert_eq!((main_info.ahead, main_info.behind), (Some(1), Some(0)));
        assert_eq!(main_info.tip_commit, c2);

        let dev_info = branches
            .iter()
            .find(|b| b.name == "dev")
            .expect("应包含 dev");
        assert!(!dev_info.is_current);
        assert_eq!(dev_info.upstream, None, "dev 未配置上游");
        assert_eq!(dev_info.tip_commit, c1);
    }

    /// 空仓库：无分支可列。
    #[test]
    fn list_branches_empty_repo() {
        let (_dir, repo) = init_repo();
        let branches = list_branches(&repo).expect("list_branches 失败");
        assert!(branches.is_empty(), "unborn HEAD 时分支列表应为空");
    }

    /// (12) checkout：本地分支往返切换，工作区内容与 head_branch 跟随。
    #[test]
    fn checkout_switches_local_branches() {
        let (_dir, mut repo) = init_repo();
        commit_file(&repo, "a.txt", "v1\n", "initial");
        let main = repo
            .head()
            .expect("读取 HEAD 失败")
            .shorthand()
            .expect("HEAD 应为分支")
            .to_string();
        {
            // dev 分支停在当前 tip（块作用域及时释放对 repo 的借用）。
            let tip = repo
                .head()
                .expect("读取 HEAD 失败")
                .peel_to_commit()
                .expect("解析 HEAD 失败");
            repo.branch("dev", &tip, false).expect("创建 dev 失败");
        }

        // 切到 dev 并提交不同内容。
        checkout_branch(&mut repo, "dev").expect("切换到 dev 失败");
        let c2 = commit_file(&repo, "a.txt", "v2\n", "on dev");
        assert_eq!(
            repo_info(&repo)
                .expect("repo_info 失败")
                .head_branch
                .as_deref(),
            Some("dev")
        );

        // 切回主线：内容回到 v1；再切 dev：内容 v2。
        checkout_branch(&mut repo, &main).expect("切回主线失败");
        assert_eq!(read_workdir(&repo, "a.txt"), "v1\n");
        checkout_branch(&mut repo, "dev").expect("再切 dev 失败");
        assert_eq!(read_workdir(&repo, "a.txt"), "v2\n");
        let info = repo_info(&repo).expect("repo_info 失败");
        assert_eq!(info.head_branch.as_deref(), Some("dev"));
        assert_eq!(info.head_commit, c2);
    }

    /// 读取 workdir 文件内容（测试辅助）。
    fn read_workdir(repo: &git2::Repository, path: &str) -> String {
        std::fs::read_to_string(repo.workdir().expect("应有工作区").join(path))
            .expect("读取文件失败")
    }

    /// (13) checkout 安全性：会被覆盖的未提交修改报错；不冲突的修改保留。
    #[test]
    fn checkout_rejects_conflicting_local_changes() {
        let (_dir, mut repo) = init_repo();
        commit_file(&repo, "a.txt", "v1\n", "initial");
        let main = repo
            .head()
            .expect("读取 HEAD 失败")
            .shorthand()
            .expect("HEAD 应为分支")
            .to_string();
        {
            let tip = repo
                .head()
                .expect("读取 HEAD 失败")
                .peel_to_commit()
                .expect("解析 HEAD 失败");
            repo.branch("dev", &tip, false).expect("创建 dev 失败");
        }

        // dev 上 a.txt 改为 v2。
        checkout_branch(&mut repo, "dev").expect("切换到 dev 失败");
        commit_file(&repo, "a.txt", "v2\n", "on dev");
        checkout_branch(&mut repo, &main).expect("切回主线失败");

        // 未提交修改 a.txt（与 dev 冲突）→ 切换失败且留在原分支。
        std::fs::write(repo.workdir().expect("应有工作区").join("a.txt"), "dirty\n")
            .expect("写入失败");
        match checkout_branch(&mut repo, "dev") {
            Err(AppError::Git(_)) => {}
            Err(e) => panic!("期望 Git 错误，实际 {e:?}"),
            Ok(()) => panic!("有冲突的未提交修改时不应切换成功"),
        }
        assert_eq!(
            repo_info(&repo)
                .expect("repo_info 失败")
                .head_branch
                .as_deref(),
            Some(main.as_str()),
            "失败的切换不应移动 HEAD"
        );

        // 丢弃脏改（恢复 v1），新增不冲突的 untracked 文件后切换成功且文件保留。
        std::fs::write(repo.workdir().expect("应有工作区").join("a.txt"), "v1\n")
            .expect("恢复失败");
        std::fs::write(
            repo.workdir().expect("应有工作区").join("note.md"),
            "note\n",
        )
        .expect("写入失败");
        checkout_branch(&mut repo, "dev").expect("不冲突修改不应阻断切换");
        assert_eq!(read_workdir(&repo, "a.txt"), "v2\n");
        assert_eq!(
            read_workdir(&repo, "note.md"),
            "note\n",
            "untracked 文件应保留"
        );
    }

    /// (14) checkout 远程分支：创建同名本地跟踪分支（DWIM），二次点击
    /// 远程名时切换到既有本地分支。
    #[test]
    fn checkout_remote_creates_tracking_branch() {
        let (_dir, mut repo) = init_repo();
        let c1 = commit_file(&repo, "a.txt", "v1\n", "initial");

        // 模拟 fetch：origin/feat 指向 c1。
        create_remote_ref(&repo, "feat", &c1);

        checkout_branch(&mut repo, "origin/feat").expect("检出远程分支失败");
        let info = repo_info(&repo).expect("repo_info 失败");
        assert_eq!(
            info.head_branch.as_deref(),
            Some("feat"),
            "应创建并切到本地 feat"
        );
        assert_eq!(info.head_commit, c1);

        // 本地 feat 的上游应配置为 origin/feat。
        let upstream_name = {
            let local = repo
                .find_branch("feat", git2::BranchType::Local)
                .expect("本地 feat 应存在");
            let upstream = local.upstream().expect("上游应已配置");
            upstream.name().expect("上游名非法").map(str::to_string)
        };
        assert_eq!(upstream_name.as_deref(), Some("origin/feat"));

        // 再次按远程名检出：本地已存在 → 直接切换本地 feat，不报错。
        checkout_branch(&mut repo, "origin/feat").expect("二次检出远程分支失败");
        assert_eq!(
            repo_info(&repo)
                .expect("repo_info 失败")
                .head_branch
                .as_deref(),
            Some("feat")
        );
    }

    /// (15) checkout 参数校验：空名 / 非法名 / 不存在的分支。
    #[test]
    fn checkout_invalid_and_unknown_branch() {
        let (_dir, mut repo) = init_repo();
        commit_file(&repo, "a.txt", "v1\n", "initial");

        match checkout_branch(&mut repo, "  ") {
            Err(AppError::InvalidArg(_)) => {}
            other => panic!("空分支名应报 InvalidArg，实际 {other:?}"),
        }
        match checkout_branch(&mut repo, "bad..name") {
            Err(AppError::InvalidArg(_)) => {}
            other => panic!("非法分支名应报 InvalidArg，实际 {other:?}"),
        }
        match checkout_branch(&mut repo, "no-such-branch") {
            Err(AppError::NotFound(_)) => {}
            other => panic!("不存在分支应报 NotFound，实际 {other:?}"),
        }
    }

    /// (16) 含 `/` 的远程名：按最长前缀匹配拆分（my/remote/dev →
    /// 远程 `my/remote` + 本地 `dev`），且优先于短名远程 `my` 命中。
    #[test]
    fn checkout_slash_remote_longest_prefix_match() {
        let (_dir, mut repo) = init_repo();
        let c1 = commit_file(&repo, "a.txt", "v1\n", "initial");

        // 同时配置 my 与 my/remote 两个远程，制造前缀歧义。
        repo.remote("my", "https://example.com/my.git")
            .expect("配置 my 失败");
        repo.remote("my/remote", "https://example.com/my-remote.git")
            .expect("配置 my/remote 失败");
        let oid = git2::Oid::from_str(&c1).expect("oid 非法");
        repo.reference("refs/remotes/my/remote/dev", oid, true, "test")
            .expect("创建远程跟踪引用失败");

        checkout_branch(&mut repo, "my/remote/dev").expect("检出含斜杠远程分支失败");
        let info = repo_info(&repo).expect("repo_info 失败");
        assert_eq!(info.head_branch.as_deref(), Some("dev"), "本地短名应为 dev");

        // 跟踪配置指向完整远程名 my/remote（而非歧义的 my）。
        // libgit2 限制：live config 对象不能直接 get_str，经 snapshot 读取。
        let config = repo
            .config()
            .expect("读取配置失败")
            .snapshot()
            .expect("创建配置快照失败");
        assert_eq!(
            config
                .get_str("branch.dev.remote")
                .expect("remote 应已配置"),
            "my/remote"
        );
        assert_eq!(
            config.get_str("branch.dev.merge").expect("merge 应已配置"),
            "refs/heads/dev"
        );
    }

    /// 造一个不更新任何引用的提交（父为当前 HEAD），返回提交 id。
    fn make_orphan_commit(repo: &git2::Repository, path: &str, content: &str) -> String {
        let file_path = repo.workdir().expect("应有工作区").join(path);
        std::fs::write(&file_path, content).expect("写入文件失败");
        let mut index = repo.index().expect("读取 index 失败");
        index.add_path(Path::new(path)).expect("add_path 失败");
        index.write().expect("写回 index 失败");
        let tree_oid = index.write_tree_to(repo).expect("write_tree 失败");
        let tree = repo.find_tree(tree_oid).expect("find_tree 失败");
        let parent = repo
            .head()
            .expect("读取 HEAD 失败")
            .peel_to_commit()
            .expect("解析 HEAD 失败");
        let oid = repo
            .commit(None, &sig(), &sig(), "orphan", &tree, &[&parent])
            .expect("创建提交失败");
        // 恢复工作区文件到 HEAD 版本，避免影响后续测试步骤。
        std::fs::write(&file_path, "v1\n").expect("恢复文件失败");
        let mut index = repo.index().expect("读取 index 失败");
        index.add_path(Path::new(path)).expect("恢复 index 失败");
        index.write().expect("写回 index 失败");
        oid.to_string()
    }

    /// (17) DWIM 失败不残留：检出冲突时不创建本地分支、不写跟踪配置
    /// （与 git CLI 行为一致）；恢复后重试能正确建分支切换。
    #[test]
    fn checkout_dwim_failure_leaves_no_residue() {
        let (_dir, mut repo) = init_repo();
        commit_file(&repo, "a.txt", "v1\n", "initial");
        let head_before = repo
            .head()
            .expect("读取 HEAD 失败")
            .peel_to_commit()
            .expect("解析 HEAD 失败")
            .id()
            .to_string();

        // 远程 dev 分支上 a.txt 内容不同 → 与本地脏改冲突。
        let c2 = make_orphan_commit(&repo, "a.txt", "remote-version\n");
        create_remote_ref(&repo, "dev", &c2);
        std::fs::write(repo.workdir().expect("应有工作区").join("a.txt"), "dirty\n")
            .expect("写入脏改失败");

        match checkout_branch(&mut repo, "origin/dev") {
            Err(AppError::Git(_)) => {}
            Err(e) => panic!("期望 Git 冲突错误，实际 {e:?}"),
            Ok(()) => panic!("冲突的 DWIM 检出不应成功"),
        }
        assert!(
            repo.find_branch("dev", git2::BranchType::Local).is_err(),
            "失败的 DWIM 不应创建本地分支"
        );
        let config = repo.config().expect("读取配置失败");
        assert!(
            config.get_str("branch.dev.remote").is_err(),
            "失败的 DWIM 不应写跟踪配置"
        );
        assert_eq!(
            repo.head()
                .expect("读取 HEAD 失败")
                .peel_to_commit()
                .expect("解析失败")
                .id()
                .to_string(),
            head_before,
            "HEAD 不应移动"
        );

        // 恢复脏改后重试：成功创建跟踪分支并切换（不残留旧状态干扰）。
        std::fs::write(repo.workdir().expect("应有工作区").join("a.txt"), "v1\n")
            .expect("恢复失败");
        checkout_branch(&mut repo, "origin/dev").expect("恢复后 DWIM 应成功");
        assert_eq!(
            repo_info(&repo)
                .expect("repo_info 失败")
                .head_branch
                .as_deref(),
            Some("dev")
        );
        assert_eq!(read_workdir(&repo, "a.txt"), "remote-version\n");
    }

    #[test]
    fn conflicted_status_and_stage_resolution() {
        let (dir, mut repo) = init_repo();
        let base_oid = commit_file(&repo, "a.txt", "base\n", "base");
        let base_commit = repo
            .find_commit(git2::Oid::from_str(&base_oid).unwrap())
            .unwrap();
        let main_branch = repo.head().unwrap().shorthand().unwrap().to_string();

        // 分叉出 topic 分支并修改 a.txt
        repo.branch("topic", &base_commit, false).unwrap();
        drop(base_commit);
        checkout_branch(&mut repo, "topic").unwrap();
        commit_file(&repo, "a.txt", "theirs\n", "topic edit");

        // 切回主分支做冲突修改
        checkout_branch(&mut repo, &main_branch).unwrap();
        commit_file(&repo, "a.txt", "ours\n", "main edit");

        // 用 git CLI 制造真实 merge 冲突（含 MERGE_HEAD 与 stage 1/2/3）
        let out = std::process::Command::new("git")
            .current_dir(dir.path())
            .args(["merge", "topic"])
            .output()
            .unwrap();
        assert!(!out.status.success(), "应当产生合并冲突");

        let info = repo_info(&repo).unwrap();
        assert_eq!(info.state, RepoState::Merging);

        let statuses = status(&repo).unwrap();
        let entry = find_status(&statuses, "a.txt").expect("冲突文件不得被 status 过滤掉");
        assert!(entry.conflicted);
        assert!(entry.staged.is_none());
        assert!(entry.unstaged.is_none());

        // 未解决冲突前禁止直接 create_commit
        assert!(matches!(
            create_commit(&mut repo, "fail"),
            Err(AppError::Git(_))
        ));

        // 手工写入解决结果并 stage_file → 应清除冲突并进入 staged
        std::fs::write(dir.path().join("a.txt"), "resolved\n").unwrap();
        stage_file(&mut repo, "a.txt").unwrap();

        let after_stage = status(&repo).unwrap();
        let entry = find_status(&after_stage, "a.txt").expect("暂存后应在列表");
        assert!(!entry.conflicted);
        assert_eq!(entry.staged, Some(ChangeType::Modified));

        // 测试删除冲突：先用 stage_file 在文件不存在时清理冲突
        let mut idx = repo.index().unwrap();
        let fake = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o100644,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: repo.blob(b"x").unwrap(),
            flags: (2u16 << 12), // stage 2
            flags_extended: 0,
            path: b"deleted_conflict.txt".to_vec(),
        };
        idx.add(&fake).unwrap();
        idx.write().unwrap();
        stage_file(&mut repo, "deleted_conflict.txt").unwrap();
        assert!(
            !repo.index().unwrap().has_conflicts(),
            "文件删除时 stage_file 也应清除冲突条目"
        );
    }
}
