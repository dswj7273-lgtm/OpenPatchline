//! Hunk 与行级局部暂存 / 取消暂存 / 丢弃子模块（4.1 & 4.2）。
//!
//! 工作流程：
//! 1. 按当前 diff 范围读取真实的基准与目标字节（index/HEAD/workdir）；
//! 2. 校验路径安全性、非二进制、非冲突且选区下标有效；
//! 3. 根据 [`DiffPatchAction`] 与 [`DiffLineSelection`] 精确构造目标内容
//!    （保留 CRLF 与 EOF 换行符语义）；
//! 4. 使用 `git2::Patch::from_buffers` 生成标准 unified patch；
//! 5. 先执行 `git apply [--cached] --check -` 校验，再正式应用，防止索引损坏。

use std::collections::HashSet;
use std::path::Path;

use super::diff::{blob_bytes_from_index, blob_bytes_from_tree, find_delta, find_similar};
use super::{
    fresh_index, head_tree, path_str, read_workdir_file, resolve_workdir_path, validate_rel_path,
};
use crate::diff_engine::{self, DiffOptions as TextDiffOptions};
use crate::error::{AppError, AppResult};
use crate::git_remote::run_git_with_input;
use crate::types::{
    AlignedRow, DiffLineSelection, DiffPatchAction, DiffScope, DiffScopeKind, LineKind, PatchSide,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// 把选区作用到工作区文件或暂存区（hunk 级与行级共用）。
pub fn apply_diff_selection(
    repo: &mut git2::Repository,
    scope: &DiffScope,
    path: &str,
    action: DiffPatchAction,
    selections: &[DiffLineSelection],
    ignore_ws: bool,
) -> AppResult<()> {
    match (scope.kind, action) {
        (DiffScopeKind::Workdir, DiffPatchAction::Stage | DiffPatchAction::Discard)
        | (DiffScopeKind::Staged, DiffPatchAction::Unstage) => {}
        _ => {
            return Err(AppError::InvalidArg(
                "当前 diff 范围不支持该局部操作（仅工作区支持暂存/丢弃，暂存区支持取消暂存）"
                    .to_string(),
            ));
        }
    }
    if selections.is_empty() {
        return Err(AppError::InvalidArg("未选中任何变更行".to_string()));
    }

    let rel = validate_rel_path(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?
        .to_path_buf();
    let index = fresh_index(repo)?;

    if is_conflicted_in_index(&index, rel) {
        return Err(AppError::InvalidArg(
            "冲突文件暂不支持行/块级局部操作，请先解决冲突并整体标记为已解决".to_string(),
        ));
    }

    let loaded = load_scope_pair(repo, &workdir, &index, scope.kind, path)?;
    if loaded.old_bytes.as_deref().is_some_and(is_binary_bytes)
        || loaded.new_bytes.as_deref().is_some_and(is_binary_bytes)
    {
        return Err(AppError::InvalidArg(
            "二进制文件不支持行/块级局部操作".to_string(),
        ));
    }

    let old_str = bytes_to_utf8(loaded.old_bytes.as_deref())?;
    let new_str = bytes_to_utf8(loaded.new_bytes.as_deref())?;
    // 选区行下标来自前端视图；必须与视图使用相同的空白比较选项，
    // 否则行下标错位会误操作到别的行。
    let rows = diff_engine::diff_strings(
        old_str,
        new_str,
        &TextDiffOptions {
            ignore_whitespace: ignore_ws,
            ..TextDiffOptions::default()
        },
    );

    let target_text = build_patched_text(
        old_str,
        new_str,
        &rows,
        action,
        selections,
        loaded.old_bytes.is_none(),
        loaded.new_bytes.is_none(),
    )?;
    let target_bytes = target_text.as_ref().map(|s| s.as_bytes());

    match action {
        DiffPatchAction::Stage => apply_stage_patch(&workdir, &index, &loaded, path, target_bytes),
        DiffPatchAction::Unstage => {
            apply_unstage_patch(&workdir, &index, &loaded, path, target_bytes)
        }
        DiffPatchAction::Discard => apply_discard_patch(&workdir, &loaded, path, target_bytes),
    }
}

struct LoadedScopePair {
    old_bytes: Option<Vec<u8>>,
    new_bytes: Option<Vec<u8>>,
    old_path: Option<String>,
    new_path: Option<String>,
}

fn is_conflicted_in_index(index: &git2::Index, rel: &Path) -> bool {
    (1..=3).any(|stage| index.get_path(rel, stage).is_some())
}

fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

fn bytes_to_utf8(bytes: Option<&[u8]>) -> AppResult<&str> {
    let Some(raw) = bytes else {
        return Ok("");
    };
    std::str::from_utf8(raw).map_err(|_| {
        AppError::InvalidArg(
            "文件包含非 UTF-8 字节，暂不支持局部补丁，请使用整文件操作".to_string(),
        )
    })
}

fn load_scope_pair(
    repo: &git2::Repository,
    workdir: &Path,
    index: &git2::Index,
    kind: DiffScopeKind,
    path: &str,
) -> AppResult<LoadedScopePair> {
    let head_tree = head_tree(repo)?;
    match kind {
        DiffScopeKind::Staged => {
            let mut opts = git2::DiffOptions::new();
            opts.context_lines(0);
            let mut diff = repo
                .diff_tree_to_index(head_tree.as_ref(), Some(index), Some(&mut opts))
                .map_err(|e| AppError::Git(format!("计算 {path} 的暂存 diff 失败: {e}")))?;
            find_similar(&mut diff)?;
            let delta = find_delta(diff.deltas(), path, false)
                .ok_or_else(|| AppError::NotFound(format!("文件 {path} 暂存区无变更")))?;
            let status = delta.status();
            let old_path = path_str(delta.old_file().path());
            let new_path = path_str(delta.new_file().path());
            let old_bytes = if status == git2::Delta::Added {
                None
            } else {
                blob_bytes_from_tree(
                    repo,
                    head_tree.as_ref(),
                    old_path.as_deref().unwrap_or(path),
                )?
            };
            let new_bytes = if status == git2::Delta::Deleted {
                None
            } else {
                blob_bytes_from_index(repo, index, new_path.as_deref().unwrap_or(path))?
            };
            Ok(LoadedScopePair {
                old_bytes,
                new_bytes,
                old_path,
                new_path,
            })
        }
        DiffScopeKind::Workdir => {
            let mut opts = git2::DiffOptions::new();
            opts.context_lines(0).include_untracked(true);
            let mut diff = repo
                .diff_index_to_workdir(Some(index), Some(&mut opts))
                .map_err(|e| AppError::Git(format!("计算 {path} 的工作区 diff 失败: {e}")))?;
            find_similar(&mut diff)?;
            let (old_path, new_path) = match find_delta(diff.deltas(), path, false) {
                Some(delta) => (
                    path_str(delta.old_file().path()),
                    path_str(delta.new_file().path()),
                ),
                None => (Some(path.to_string()), Some(path.to_string())),
            };
            let old_lookup = old_path.as_deref().unwrap_or(path);
            let old_bytes = match blob_bytes_from_index(repo, index, old_lookup)? {
                Some(b) => Some(b),
                None => blob_bytes_from_tree(repo, head_tree.as_ref(), old_lookup)?,
            };
            let new_lookup = new_path.as_deref().unwrap_or(path);
            let new_bytes = read_workdir_file(workdir, new_lookup)?;
            Ok(LoadedScopePair {
                old_bytes,
                new_bytes,
                old_path,
                new_path,
            })
        }
        _ => Err(AppError::InvalidArg("不支持的 diff 范围".to_string())),
    }
}

/// 根据 diff 行、动作与选区重建精确的目标文本；返回 `None` 表示文件整体被删除或取消创建。
pub(super) fn build_patched_text(
    old_str: &str,
    new_str: &str,
    rows: &[AlignedRow],
    action: DiffPatchAction,
    selections: &[DiffLineSelection],
    old_is_none: bool,
    new_is_none: bool,
) -> AppResult<Option<String>> {
    let mut sel_left = HashSet::new();
    let mut sel_right = HashSet::new();
    for sel in selections {
        let row = rows
            .get(sel.row_index)
            .ok_or_else(|| AppError::InvalidArg(format!("选区行下标越界: {}", sel.row_index)))?;
        if matches!(sel.side, PatchSide::Old | PatchSide::Both)
            && row
                .left
                .as_ref()
                .is_some_and(|c| c.kind == LineKind::Removed)
        {
            sel_left.insert(sel.row_index);
        }
        if matches!(sel.side, PatchSide::New | PatchSide::Both)
            && row
                .right
                .as_ref()
                .is_some_and(|c| c.kind == LineKind::Added)
        {
            sel_right.insert(sel.row_index);
        }
    }
    if sel_left.is_empty() && sel_right.is_empty() {
        return Err(AppError::InvalidArg("选区不包含任何变更行".to_string()));
    }

    let old_lines: Vec<&str> = if old_str.is_empty() {
        Vec::new()
    } else {
        old_str.split_terminator('\n').collect()
    };
    let new_lines: Vec<&str> = if new_str.is_empty() {
        Vec::new()
    } else {
        new_str.split_terminator('\n').collect()
    };
    let old_eof_nl = old_str.is_empty() || old_str.ends_with('\n');
    let new_eof_nl = new_str.is_empty() || new_str.ends_with('\n');

    let forward = matches!(action, DiffPatchAction::Stage);
    let mut pieces: Vec<(&str, bool)> = Vec::with_capacity(rows.len());

    for (idx, row) in rows.iter().enumerate() {
        if let (Some(l), Some(r)) = (&row.left, &row.right)
            && l.kind == LineKind::Context
            && r.kind == LineKind::Context
        {
            let old_idx = l.lineno.map(|n| n.saturating_sub(1) as usize).unwrap_or(0);
            let new_idx = r.lineno.map(|n| n.saturating_sub(1) as usize).unwrap_or(0);
            let old_nl = if old_idx + 1 < old_lines.len() {
                true
            } else {
                old_eof_nl
            };
            let new_nl = if new_idx + 1 < new_lines.len() {
                true
            } else {
                new_eof_nl
            };
            let prefer_nl = if new_idx + 1 == new_lines.len() && old_idx + 1 < old_lines.len() {
                new_nl
            } else {
                old_nl
            };
            pieces.push((l.content.as_str(), prefer_nl));
            continue;
        }

        if let Some(l) = &row.left
            && l.kind == LineKind::Removed
        {
            let old_idx = l.lineno.map(|n| n.saturating_sub(1) as usize).unwrap_or(0);
            let old_nl = if old_idx + 1 < old_lines.len() {
                true
            } else {
                old_eof_nl
            };
            let keep_old = if forward {
                !sel_left.contains(&idx)
            } else {
                sel_left.contains(&idx)
            };
            if keep_old {
                pieces.push((l.content.as_str(), old_nl));
            }
        }

        if let Some(r) = &row.right
            && r.kind == LineKind::Added
        {
            let new_idx = r.lineno.map(|n| n.saturating_sub(1) as usize).unwrap_or(0);
            let new_nl = if new_idx + 1 < new_lines.len() {
                true
            } else {
                new_eof_nl
            };
            let keep_new = if forward {
                sel_right.contains(&idx)
            } else {
                !sel_right.contains(&idx)
            };
            if keep_new {
                pieces.push((r.content.as_str(), new_nl));
            }
        }
    }

    if pieces.is_empty() {
        let should_delete = if forward { new_is_none } else { old_is_none };
        if should_delete {
            return Ok(None);
        }
        return Ok(Some(String::new()));
    }

    let mut out = String::new();
    let last_idx = pieces.len() - 1;
    for (i, (text, end_nl)) in pieces.into_iter().enumerate() {
        out.push_str(text);
        if i < last_idx || end_nl {
            out.push('\n');
        }
    }
    Ok(Some(out))
}

fn index_mode_or_default(workdir: &Path, index: &git2::Index, path: &str) -> u32 {
    if let Some(entry) = index.get_path(Path::new(path), 0)
        && (entry.mode == 0o100755 || entry.mode == 0o100644)
    {
        return entry.mode;
    }
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(workdir.join(path))
        && (meta.permissions().mode() & 0o111) != 0
    {
        return 0o100755;
    }
    0o100644
}

fn build_unified_patch_for_file(
    old_bytes: Option<&[u8]>,
    new_bytes: Option<&[u8]>,
    path: &str,
    mode: u32,
) -> AppResult<Vec<u8>> {
    let rel = Path::new(path);
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(3);
    let patch = git2::Patch::from_buffers(
        old_bytes.unwrap_or(&[]),
        Some(rel),
        new_bytes.unwrap_or(&[]),
        Some(rel),
        Some(&mut opts),
    )
    .map_err(|e| AppError::Git(format!("构造补丁失败: {e}")))?;

    let num_hunks = patch.num_hunks();
    if num_hunks == 0 && old_bytes.is_none() == new_bytes.is_none() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let mode_str = format!("{mode:o}");
    out.extend_from_slice(format!("diff --git a/{path} b/{path}\n").as_bytes());
    if old_bytes.is_none() {
        out.extend_from_slice(format!("new file mode {mode_str}\n").as_bytes());
        out.extend_from_slice(b"--- /dev/null\n");
    } else {
        out.extend_from_slice(format!("--- a/{path}\n").as_bytes());
    }
    if new_bytes.is_none() {
        out.extend_from_slice(format!("deleted file mode {mode_str}\n").as_bytes());
        out.extend_from_slice(b"+++ /dev/null\n");
    } else {
        out.extend_from_slice(format!("+++ b/{path}\n").as_bytes());
    }

    for h_idx in 0..num_hunks {
        let (hunk, line_count) = patch
            .hunk(h_idx)
            .map_err(|e| AppError::Git(format!("读取补丁 hunk 失败: {e}")))?;
        out.extend_from_slice(hunk.header());
        if !hunk.header().ends_with(b"\n") {
            out.push(b'\n');
        }
        for l_idx in 0..line_count {
            let line = patch
                .line_in_hunk(h_idx, l_idx)
                .map_err(|e| AppError::Git(format!("读取补丁行失败: {e}")))?;
            let origin = line.origin();
            if matches!(origin, ' ' | '+' | '-') {
                out.push(origin as u8);
            }
            out.extend_from_slice(line.content());
        }
    }
    Ok(out)
}

fn check_and_apply_git_patch(workdir: &Path, patch: &[u8], cached: bool) -> AppResult<()> {
    if patch.is_empty() {
        return Err(AppError::InvalidArg("选区与目标状态无差异".to_string()));
    }
    let check_args: &[&str] = if cached {
        &["apply", "--cached", "--whitespace=nowarn", "--check", "-"]
    } else {
        &["apply", "--whitespace=nowarn", "--check", "-"]
    };
    run_git_with_input(workdir, check_args, Some(patch))?;

    let apply_args: &[&str] = if cached {
        &["apply", "--cached", "--whitespace=nowarn", "-"]
    } else {
        &["apply", "--whitespace=nowarn", "-"]
    };
    run_git_with_input(workdir, apply_args, Some(patch))?;
    Ok(())
}

/// 生成工作区 / 暂存区单文件的标准 unified patch 文本（v0.6 / 6.8 复制补丁）。
pub fn generate_file_patch(
    repo: &git2::Repository,
    scope: &DiffScope,
    path: &str,
) -> AppResult<String> {
    if !matches!(scope.kind, DiffScopeKind::Workdir | DiffScopeKind::Staged) {
        return Err(AppError::InvalidArg(
            "仅支持为工作区或暂存区变更生成补丁".to_string(),
        ));
    }
    let rel = validate_rel_path(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?
        .to_path_buf();
    let index = fresh_index(repo)?;
    if is_conflicted_in_index(&index, rel) {
        return Err(AppError::InvalidArg(
            "冲突文件暂不支持生成补丁，请先解决冲突".to_string(),
        ));
    }
    let loaded = load_scope_pair(repo, &workdir, &index, scope.kind, path)?;
    if loaded.old_bytes.as_deref().is_some_and(is_binary_bytes)
        || loaded.new_bytes.as_deref().is_some_and(is_binary_bytes)
    {
        return Err(AppError::InvalidArg("二进制文件不支持生成文本补丁".to_string()));
    }
    let mode = index_mode_or_default(&workdir, &index, path);
    let patch = build_unified_patch_for_file(
        loaded.old_bytes.as_deref(),
        loaded.new_bytes.as_deref(),
        path,
        mode,
    )?;
    if patch.is_empty() {
        return Err(AppError::NotFound(format!("文件 {path} 当前没有可生成的变更补丁")));
    }
    String::from_utf8(patch)
        .map_err(|e| AppError::Unexpected(format!("补丁文本不是有效 UTF-8: {e}")))
}

fn apply_stage_patch(
    workdir: &Path,
    index: &git2::Index,
    loaded: &LoadedScopePair,
    path: &str,
    target_bytes: Option<&[u8]>,
) -> AppResult<()> {
    let old_name = loaded.old_path.as_deref().unwrap_or(path);
    let new_name = loaded.new_path.as_deref().unwrap_or(path);

    // 工作区存在未暂存的重命名时，在同一次 git apply --cached 中原子移除旧索引路径并写入新索引路径。
    if old_name != new_name && index.get_path(Path::new(old_name), 0).is_some() {
        let mut combined = Vec::new();
        if let Some(old_b) = loaded.old_bytes.as_deref() {
            let mode = index_mode_or_default(workdir, index, old_name);
            combined.extend_from_slice(&build_unified_patch_for_file(
                Some(old_b),
                None,
                old_name,
                mode,
            )?);
        }
        let new_mode = index_mode_or_default(workdir, index, new_name);
        if let Some(target) = target_bytes {
            combined.extend_from_slice(&build_unified_patch_for_file(
                None,
                Some(target),
                new_name,
                new_mode,
            )?);
        }
        return check_and_apply_git_patch(workdir, &combined, true);
    }

    let mode = index_mode_or_default(workdir, index, new_name);
    let patch =
        build_unified_patch_for_file(loaded.old_bytes.as_deref(), target_bytes, new_name, mode)?;
    check_and_apply_git_patch(workdir, &patch, true)
}

fn apply_unstage_patch(
    workdir: &Path,
    index: &git2::Index,
    loaded: &LoadedScopePair,
    path: &str,
    target_bytes: Option<&[u8]>,
) -> AppResult<()> {
    let index_path = loaded
        .new_path
        .as_deref()
        .or(loaded.old_path.as_deref())
        .unwrap_or(path);
    let mode = index_mode_or_default(workdir, index, index_path);
    let patch =
        build_unified_patch_for_file(loaded.new_bytes.as_deref(), target_bytes, index_path, mode)?;
    check_and_apply_git_patch(workdir, &patch, true)
}

fn apply_discard_patch(
    workdir: &Path,
    loaded: &LoadedScopePair,
    path: &str,
    target_bytes: Option<&[u8]>,
) -> AppResult<()> {
    let disk_path = loaded
        .new_path
        .as_deref()
        .or(loaded.old_path.as_deref())
        .unwrap_or(path);
    if target_bytes.is_none() && loaded.old_bytes.is_none() {
        let full = resolve_workdir_path(workdir, disk_path)?;
        if std::fs::symlink_metadata(&full).is_ok() {
            std::fs::remove_file(&full)
                .map_err(|e| AppError::Io(format!("删除未跟踪文件 {disk_path} 失败: {e}")))?;
        }
        return Ok(());
    }
    let patch = build_unified_patch_for_file(
        loaded.new_bytes.as_deref(),
        target_bytes,
        disk_path,
        0o100644,
    )?;
    check_and_apply_git_patch(workdir, &patch, false)
}
