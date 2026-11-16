//! Git 远程操作：fetch / pull 通过 git CLI 子进程执行（README Phase 3、docs/04 §8）。
//!
//! 走 CLI 而非 git2-rs 网络栈的原因：完整复用系统 git 的凭证链路
//! （SSH agent、`~/.ssh/config`、macOS Keychain 凭证助手等），避免在
//! 应用内重新实现认证。读操作（分支列表等）仍走 git2-rs。
//!
//! 约定：
//! - 子进程设置 `GIT_TERMINAL_PROMPT=0`：GUI 进程没有终端，凭证提示
//!   与其挂死不如快速失败（Keychain / ssh-agent 认证不受影响）；
//! - pull 固定 `--no-edit`：避免无终端环境下合并提交信息编辑器挂起；
//! - 显式传入的远程名必须是仓库已配置的远程，防止 `--all` /
//!   `--upload-pack=…` 等以选项形式注入 git 参数；
//! - 输出按 `\r`/`\n` 拆行规整（fetch 进度以 `\r` 刷新会产生大量行），
//!   并截断到尾部若干行，防止巨型载荷走 IPC；
//! - **已知权衡**：子进程无超时，且期间持有该仓库的条目锁——网络
//!   黑洞（TCP 不超时）会让该仓库的后续操作一直排队，需重启应用
//!   恢复。MVP 接受该权衡（标准库实现带管道排水的超时.kill 复杂度
//!   高、易引入管道死锁）；`GIT_TERMINAL_PROMPT=0` 已消除最常见的
//!   凭证提示挂死。

use std::path::{Component, Path};
use std::process::Command;

use crate::error::{AppError, AppResult};
use crate::git_service;
use crate::types::{FetchResult, GitActionResult, PullResult, PushResult, StashEntry};

/// 返回给前端的输出摘要行数上限。
const MAX_OUTPUT_LINES: usize = 50;
/// 提交签名回退用户名（仓库与全局配置均缺失时）。
const FALLBACK_SIGNATURE_NAME: &str = "OpenPatchline";
const FALLBACK_SIGNATURE_EMAIL: &str = "openpatchline@local";

/// git 可执行文件候选：GUI 进程（从 Finder/Dock 启动）不继承 shell 的
/// PATH，Homebrew 安装的 git 可能不在默认 PATH 里；依次回退常见位置。
const GIT_BIN_CANDIDATES: &[&str] = &["git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];

/// 在 `workdir` 下运行 `git <args..>` 子进程，返回原始 `(stdout, stderr)`。
fn run_git_raw(workdir: &Path, args: &[&str]) -> AppResult<(String, String)> {
    let output = 'spawn: {
        for bin in GIT_BIN_CANDIDATES {
            match Command::new(bin)
                .current_dir(workdir)
                .args(args)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
            {
                Ok(output) => break 'spawn output,
                // 候选不存在（NotFound）→ 尝试下一个；其他错误（权限等）如实上报。
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(AppError::Io(format!("启动 git 子进程失败: {e}"))),
            }
        }
        return Err(AppError::Io(format!(
            "找不到 git 可执行文件（已尝试 {}）；请安装 git CLI（xcode-select --install）",
            GIT_BIN_CANDIDATES.join(", "),
        )));
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(AppError::Git(format!(
            "git {} 失败:\n{}",
            args.join(" "),
            detail
        )));
    }
    Ok((stdout, stderr))
}

/// 在 `workdir` 下运行 `git <args..>` 子进程。
///
/// 成功返回规整后的 stdout+stderr；失败（非零退出）返回携带 stderr
/// 摘要的 [`AppError::Git`]。stderr 为空时退回 stdout（个别 git 子命令
/// 把错误打到 stdout）。
fn run_git(workdir: &Path, args: &[&str]) -> AppResult<String> {
    let (stdout, stderr) = run_git_raw(workdir, args)?;
    Ok(normalize_output(&stdout, &stderr))
}

/// 当仓库/全局未配置 git 签名时，附加 `-c user.name=... -c user.email=...` 运行提交类命令。
fn run_git_with_signature(
    repo: &git2::Repository,
    workdir: &Path,
    args: &[&str],
) -> AppResult<String> {
    if repo.signature().is_ok() {
        return run_git(workdir, args);
    }
    let name_cfg = format!("user.name={FALLBACK_SIGNATURE_NAME}");
    let email_cfg = format!("user.email={FALLBACK_SIGNATURE_EMAIL}");
    let mut full_args = vec!["-c", name_cfg.as_str(), "-c", email_cfg.as_str()];
    full_args.extend_from_slice(args);
    run_git(workdir, &full_args)
}

/// 规整子进程输出：按 `\r`/`\n` 拆行、去空行、只保留尾部若干行。
fn normalize_output(stdout: &str, stderr: &str) -> String {
    let mut lines: Vec<&str> = stdout
        .split(['\r', '\n'])
        .chain(stderr.split(['\r', '\n']))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() > MAX_OUTPUT_LINES {
        lines = lines[lines.len() - MAX_OUTPUT_LINES..].to_vec();
    }
    lines.join("\n")
}

/// 仓库的已配置远程名列表（去重排序，测试与校验共用）。
fn remote_names(repo: &git2::Repository) -> AppResult<Vec<String>> {
    let remotes = repo
        .remotes()
        .map_err(|e| AppError::Git(format!("枚举远程失败: {e}")))?;
    let mut names: Vec<String> = (0..remotes.len())
        .filter_map(|i| remotes.get(i).ok().flatten().map(str::to_string))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// 解析默认远程：显式指定优先（**必须是已配置的远程名**，防止把
/// `--all` / `--upload-pack=…` 等选项串注入 `git fetch` 参数）；
/// 否则取 `origin`，没有 `origin` 时取第一个；仓库无远程报
/// [`AppError::NotFound`]。
fn default_remote(repo: &git2::Repository, remote: Option<&str>) -> AppResult<String> {
    let names = remote_names(repo)?;
    if let Some(name) = remote.map(str::trim).filter(|s| !s.is_empty()) {
        if names.iter().any(|n| n == name) {
            return Ok(name.to_string());
        }
        return Err(AppError::InvalidArg(format!(
            "远程 {name} 未配置（可选：{}）",
            names.join(", ")
        )));
    }
    let first = names
        .first()
        .cloned()
        .ok_or_else(|| AppError::NotFound("仓库没有配置远程（remote），无法拉取".to_string()))?;
    if names.iter().any(|n| n == "origin") {
        Ok("origin".to_string())
    } else {
        Ok(first)
    }
}

/// 从远程拉取（fetch）：更新远程跟踪分支，不改动工作区。
///
/// `remote` 为 None 时取默认远程（origin 优先）；带 `--prune` 清理
/// 远程已删除的跟踪引用。
pub fn fetch(
    repo: &git2::Repository,
    workdir: &Path,
    remote: Option<&str>,
) -> AppResult<FetchResult> {
    let remote_name = default_remote(repo, remote)?;
    let output = run_git(workdir, &["fetch", "--prune", &remote_name])?;
    Ok(FetchResult {
        remote: remote_name,
        output,
    })
}

/// 检测 pull 策略是否已配置（pull.rebase / pull.ff / branch.<b>.rebase /
/// branch.<b>.ff，含全局配置）。
///
/// 未配置时新版 git（≥2.33）对发散分支直接 `fatal: Need to specify how
/// to reconcile divergent branches`——此时显式追加 `--ff`（合并语义，
/// 与 git 历史默认一致）；已配置则不传标志，尊重用户配置。
fn pull_strategy_configured(repo: &git2::Repository) -> bool {
    let Ok(config) = repo.config() else {
        return false;
    };
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_string));
    if let Some(branch) = branch
        && (config.get_bool(&format!("branch.{branch}.rebase")).is_ok()
            || config.get_string(&format!("branch.{branch}.ff")).is_ok())
    {
        return true;
    }
    config.get_bool("pull.rebase").is_ok() || config.get_string("pull.ff").is_ok()
}

/// 拉取并合并到当前分支（pull）：遵循仓库 pull.rebase / merge 配置。
///
/// - `--no-edit` 阻止合并提交信息编辑器在无终端环境下挂起；
/// - 未配置任何 pull 策略时追加 `--ff`（见 [`pull_strategy_configured`]），
///   避免新版 git 对发散分支直接失败；
/// - 冲突 / 无上游 / 网络失败等由 git 以非零退出报告，stderr 摘要
///   随 [`AppError::Git`] 返回（注意：冲突的 pull 已把冲突标记写入
///   工作区并留下 MERGE_HEAD，由前端刷新状态呈现）；
/// - 成功后重新读取仓库信息（HEAD 可能已移动）。
pub fn pull(repo: &git2::Repository, workdir: &Path) -> AppResult<PullResult> {
    let mut args: Vec<&str> = vec!["pull", "--no-edit"];
    if !pull_strategy_configured(repo) {
        args.push("--ff");
    }
    let output = run_git(workdir, &args)?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PullResult {
        output,
        repo: repo_info,
    })
}

/// 推送当前分支（push）。
///
/// - 当前分支已配置上游 → `git push`；
/// - 无上游但存在远程 → `git push --set-upstream <remote> <branch>`
///   （推送同时建立跟踪，与 IDEA 的默认行为一致）；
/// - 分离 HEAD / 空仓库 / 无远程直接报 [`AppError::InvalidArg`] /
///   [`AppError::NotFound`]；
/// - 非快进被拒（远端有新提交）等由 git 以非零退出报告，stderr 摘要
///   随 [`AppError::Git`] 返回；不提供强制推送（--force）。
pub fn push(repo: &git2::Repository, workdir: &Path) -> AppResult<PushResult> {
    // HEAD 必须在分支上（分离 HEAD / unborn 无法确定推送目标）。
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string))
        .ok_or_else(|| AppError::InvalidArg("分离 HEAD 或空仓库，无法推送".to_string()))?;
    let has_upstream = repo
        .find_branch(&branch, git2::BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .is_some();
    let remote_name = default_remote(repo, None)?;
    let args: Vec<&str> = if has_upstream {
        vec!["push"]
    } else {
        vec![
            "push",
            "--set-upstream",
            remote_name.as_str(),
            branch.as_str(),
        ]
    };
    let output = run_git(workdir, &args)?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PushResult {
        output,
        repo: repo_info,
    })
}

/// 校验普通引用/参数非空且不以 `-` 开头，防止注入 git CLI 选项。
fn validate_non_flag<'a>(raw: &'a str, label: &str) -> AppResult<&'a str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidArg(format!("{label}不能为空")));
    }
    if trimmed.starts_with('-') {
        return Err(AppError::InvalidArg(format!("非法{label}: {trimmed}")));
    }
    Ok(trimmed)
}

/// 校验分支名合法性（非选项 + `refs/heads/<name>` 合法）。
fn validate_branch_name(raw: &str) -> AppResult<&str> {
    let name = validate_non_flag(raw, "分支名")?;
    if !git2::Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(AppError::InvalidArg(format!("非法分支名: {name}")));
    }
    Ok(name)
}

/// 校验标签名合法性（非选项 + `refs/tags/<name>` 合法）。
fn validate_tag_name(raw: &str) -> AppResult<&str> {
    let name = validate_non_flag(raw, "标签名")?;
    if !git2::Reference::is_valid_name(&format!("refs/tags/{name}")) {
        return Err(AppError::InvalidArg(format!("非法标签名: {name}")));
    }
    Ok(name)
}

/// 校验提交或引用目标在仓库中可解析（且不含空白/控制字符或 `-` 前缀）。
fn validate_target_ref<'a>(
    repo: &git2::Repository,
    raw: &'a str,
    label: &str,
) -> AppResult<&'a str> {
    let target = validate_non_flag(raw, label)?;
    if target.chars().any(char::is_whitespace) {
        return Err(AppError::InvalidArg(format!("非法{label}: {target}")));
    }
    repo.revparse_single(target)
        .map_err(|_| AppError::NotFound(format!("{label}不存在: {target}")))?;
    Ok(target)
}

/// 构造通用写操作返回结果（刷新 repo_info）。
fn action_result(repo: &git2::Repository, output: String) -> AppResult<GitActionResult> {
    Ok(GitActionResult {
        output,
        repo: git_service::repo_info(repo)?,
    })
}

/// 从全部已配置远程拉取并清理失效远程分支（`git fetch --all --prune`）。
pub fn fetch_all(repo: &git2::Repository, workdir: &Path) -> AppResult<GitActionResult> {
    let names = remote_names(repo)?;
    if names.is_empty() {
        return Err(AppError::NotFound(
            "仓库没有配置远程（remote），无法拉取".to_string(),
        ));
    }
    let output = run_git(workdir, &["fetch", "--all", "--prune"])?;
    action_result(repo, output)
}

/// 使用 rebase + autostash 策略拉取并重放当前分支（`git pull --rebase --autostash --no-edit`）。
pub fn pull_rebase(repo: &git2::Repository, workdir: &Path) -> AppResult<PullResult> {
    let output = run_git(workdir, &["pull", "--rebase", "--autostash", "--no-edit"])?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PullResult {
        output,
        repo: repo_info,
    })
}

/// 安全强推当前分支（`git push --force-with-lease`；无上游时自动 `--set-upstream`）。
pub fn push_force_with_lease(repo: &git2::Repository, workdir: &Path) -> AppResult<PushResult> {
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string))
        .ok_or_else(|| AppError::InvalidArg("分离 HEAD 或空仓库，无法推送".to_string()))?;
    let has_upstream = repo
        .find_branch(&branch, git2::BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .is_some();
    let remote_name = default_remote(repo, None)?;
    let args: Vec<&str> = if has_upstream {
        vec!["push", "--force-with-lease"]
    } else {
        vec![
            "push",
            "--force-with-lease",
            "--set-upstream",
            remote_name.as_str(),
            branch.as_str(),
        ]
    };
    let output = run_git(workdir, &args)?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PushResult {
        output,
        repo: repo_info,
    })
}

/// 推送所有本地标签到默认远程（`git push <remote> --tags`）。
pub fn push_tags(repo: &git2::Repository, workdir: &Path) -> AppResult<PushResult> {
    let remote_name = default_remote(repo, None)?;
    let output = run_git(workdir, &["push", remote_name.as_str(), "--tags"])?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PushResult {
        output,
        repo: repo_info,
    })
}

/// 新建本地分支（可选基于 `start_point` 并立即切换）。
pub fn create_branch(
    repo: &git2::Repository,
    workdir: &Path,
    name: &str,
    start_point: Option<&str>,
    checkout: bool,
) -> AppResult<GitActionResult> {
    let branch = validate_branch_name(name)?;
    let start = match start_point.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sp) => Some(validate_target_ref(repo, sp, "起始提交")?),
        None => None,
    };
    let mut args: Vec<&str> = if checkout {
        vec!["checkout", "-b", branch]
    } else {
        vec!["branch", branch]
    };
    if let Some(sp) = start {
        args.push(sp);
    }
    let output = run_git(workdir, &args)?;
    action_result(repo, output)
}

/// 删除本地分支（`git branch -d/-D -- <name>`）。
pub fn delete_branch(
    repo: &git2::Repository,
    workdir: &Path,
    name: &str,
    force: bool,
) -> AppResult<GitActionResult> {
    let branch = validate_branch_name(name)?;
    let flag = if force { "-D" } else { "-d" };
    let output = run_git(workdir, &["branch", flag, "--", branch])?;
    action_result(repo, output)
}

/// 将指定分支合并到当前分支（`git merge --no-edit -- <name>`）。
pub fn merge_branch(
    repo: &git2::Repository,
    workdir: &Path,
    name: &str,
) -> AppResult<GitActionResult> {
    let target = validate_target_ref(repo, name, "分支")?;
    let output = run_git_with_signature(repo, workdir, &["merge", "--no-edit", "--", target])?;
    action_result(repo, output)
}

/// 创建轻量标签（`git tag <name> [<target>]`）。
pub fn create_tag(
    repo: &git2::Repository,
    workdir: &Path,
    name: &str,
    target: Option<&str>,
) -> AppResult<GitActionResult> {
    let tag = validate_tag_name(name)?;
    let rev = match target.map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) => Some(validate_target_ref(repo, t, "目标提交")?),
        None => None,
    };
    let mut args = vec!["tag", tag];
    if let Some(r) = rev {
        args.push(r);
    }
    let output = run_git(workdir, &args)?;
    action_result(repo, output)
}

/// 挑选提交应用到当前分支（`git cherry-pick <commit_id>`）。
pub fn cherry_pick_commit(
    repo: &git2::Repository,
    workdir: &Path,
    commit_id: &str,
) -> AppResult<GitActionResult> {
    let target = validate_target_ref(repo, commit_id, "提交")?;
    let output = run_git_with_signature(repo, workdir, &["cherry-pick", target])?;
    action_result(repo, output)
}

/// 生成反向提交撤销指定提交（`git revert --no-edit <commit_id>`）。
pub fn revert_commit(
    repo: &git2::Repository,
    workdir: &Path,
    commit_id: &str,
) -> AppResult<GitActionResult> {
    let target = validate_target_ref(repo, commit_id, "提交")?;
    let output = run_git_with_signature(repo, workdir, &["revert", "--no-edit", target])?;
    action_result(repo, output)
}

/// 重置 HEAD 到指定提交（`git reset --<soft|mixed|hard> <target>`）。
pub fn reset_head(
    repo: &git2::Repository,
    workdir: &Path,
    target: &str,
    mode: &str,
) -> AppResult<GitActionResult> {
    let mode_flag = match mode.trim() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => {
            return Err(AppError::InvalidArg(format!(
                "不支持的 reset 模式: {other}（可选：soft / mixed / hard）"
            )))
        }
    };
    let rev = validate_target_ref(repo, target, "重置目标")?;
    let output = run_git(workdir, &["reset", mode_flag, rev])?;
    action_result(repo, output)
}

/// 丢弃单个未暂存或未跟踪文件的更改。
///
/// - 校验路径为仓库内合法相对路径（禁止 `..` 与绝对路径）；
/// - 已在 HEAD 中跟踪的文件执行 `git checkout HEAD -- <path>`；
/// - 仅在暂存区（如 unborn HEAD / 新暂存文件）的文件执行 `git checkout -- <path>`；
/// - 未跟踪文件直接从工作区删除。
pub fn discard_file(repo: &git2::Repository, workdir: &Path, path: &str) -> AppResult<()> {
    if path.is_empty() {
        return Err(AppError::InvalidArg("path 不能为空".to_string()));
    }
    let rel = Path::new(path);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err(AppError::InvalidArg(format!("非法相对路径: {path}")));
    }

    let in_head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
        .map(|tree| tree.get_path(rel).is_ok())
        .unwrap_or(false);
    let in_index = repo
        .index()
        .ok()
        .map(|idx| idx.get_path(rel, 0).is_some())
        .unwrap_or(false);

    if in_head {
        run_git(workdir, &["checkout", "HEAD", "--", path])?;
    } else if in_index {
        run_git(workdir, &["checkout", "--", path])?;
    } else {
        let full = workdir.join(rel);
        if let Ok(meta) = std::fs::symlink_metadata(&full) {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                std::fs::remove_dir_all(&full)
                    .map_err(|e| AppError::Io(format!("删除未跟踪目录 {path} 失败: {e}")))?;
            } else {
                std::fs::remove_file(&full)
                    .map_err(|e| AppError::Io(format!("删除未跟踪文件 {path} 失败: {e}")))?;
            }
        }
    }
    Ok(())
}

/// 丢弃工作区与暂存区的全部未提交更改（`git reset --hard HEAD` + `git clean -fd`）。
pub fn discard_all(repo: &git2::Repository, workdir: &Path) -> AppResult<GitActionResult> {
    let mut outputs = Vec::new();
    if repo.head().is_ok() {
        let reset_out = run_git(workdir, &["reset", "--hard", "HEAD"])?;
        if !reset_out.is_empty() {
            outputs.push(reset_out);
        }
    }
    let clean_out = run_git(workdir, &["clean", "-fd"])?;
    if !clean_out.is_empty() {
        outputs.push(clean_out);
    }
    action_result(repo, outputs.join("\n"))
}

/// 修正最近一次提交（`git commit --amend -m <message>`）。
pub fn amend_commit(
    repo: &git2::Repository,
    workdir: &Path,
    message: &str,
) -> AppResult<GitActionResult> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err(AppError::InvalidArg("提交信息不能为空".to_string()));
    }
    if repo.head().is_err() {
        return Err(AppError::InvalidArg("空仓库没有可修正的提交".to_string()));
    }
    let output = run_git_with_signature(repo, workdir, &["commit", "--amend", "-m", msg])?;
    action_result(repo, output)
}

/// 列出全部贮藏栈条目（`git stash list`）。
pub fn list_stashes(workdir: &Path) -> AppResult<Vec<StashEntry>> {
    let (stdout, _) = run_git_raw(workdir, &["stash", "list", "--format=%gd%x09%h%x09%gs"])?;
    let mut entries = Vec::new();
    for (fallback_idx, line) in stdout.lines().enumerate() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let gd = parts.next().unwrap_or_default();
        let id = parts.next().unwrap_or_default().to_string();
        let message = parts.next().unwrap_or_default().to_string();
        let index = gd
            .strip_prefix("stash@{")
            .and_then(|s| s.strip_suffix('}'))
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(fallback_idx);
        entries.push(StashEntry { index, id, message });
    }
    Ok(entries)
}

/// 将当前工作区及未跟踪文件贮藏到 stash 栈（`git stash push -u`）。
pub fn stash_push(
    repo: &git2::Repository,
    workdir: &Path,
    message: Option<&str>,
) -> AppResult<GitActionResult> {
    let msg = message.map(str::trim).filter(|s| !s.is_empty());
    let mut args = vec!["stash", "push", "-u"];
    if let Some(m) = msg {
        args.push("-m");
        args.push(m);
    }
    let output = run_git(workdir, &args)?;
    action_result(repo, output)
}

/// 应用或弹出指定贮藏条目（`git stash pop/apply stash@{index}`）。
pub fn stash_apply(
    repo: &git2::Repository,
    workdir: &Path,
    index: usize,
    pop: bool,
) -> AppResult<GitActionResult> {
    let sub = if pop { "pop" } else { "apply" };
    let stash_ref = format!("stash@{{{index}}}");
    let output = run_git(workdir, &["stash", sub, &stash_ref])?;
    action_result(repo, output)
}

/// 删除指定贮藏条目（`git stash drop stash@{index}`）。
pub fn stash_drop(
    repo: &git2::Repository,
    workdir: &Path,
    index: usize,
) -> AppResult<GitActionResult> {
    let stash_ref = format!("stash@{{{index}}}");
    let output = run_git(workdir, &["stash", "drop", &stash_ref])?;
    action_result(repo, output)
}

// ---------------------------------------------------------------------------
// 测试：以本地裸仓库充当远程，真实走 git CLI 子进程覆盖网络路径
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 固定测试签名。
    fn sig() -> git2::Signature<'static> {
        git2::Signature::now("Test User", "test@example.com").expect("构造签名失败")
    }

    /// 写入工作区文件并提交到 HEAD，返回新提交 id。
    fn commit_file(repo: &git2::Repository, path: &str, content: &str, message: &str) -> String {
        let file_path = repo.workdir().expect("仓库应有工作区").join(path);
        std::fs::write(&file_path, content).expect("写入文件失败");
        let mut index = repo.index().expect("读取 index 失败");
        index
            .add_path(std::path::Path::new(path))
            .expect("add_path 失败");
        index.write().expect("写回 index 失败");
        let tree_oid = index.write_tree_to(repo).expect("write_tree 失败");
        let tree = repo.find_tree(tree_oid).expect("find_tree 失败");
        // 空仓库首提交（unborn HEAD）无父提交。
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

    /// 初始化仓库并写入 user.name/user.email（避免依赖全局配置）。
    fn init_repo(path: &std::path::Path) -> git2::Repository {
        let repo = git2::Repository::init(path).expect("初始化仓库失败");
        let mut config = repo.config().expect("读取仓库配置失败");
        config
            .set_str("user.name", "Test User")
            .expect("设置 user.name 失败");
        config
            .set_str("user.email", "test@example.com")
            .expect("设置 user.email 失败");
        repo
    }

    /// 源仓库 / 裸远程 / 工作克隆的目录与句柄（临时目录保活到测试结束）。
    struct RemoteFixture {
        #[allow(dead_code)]
        origin_dir: tempfile::TempDir,
        #[allow(dead_code)]
        src_dir: tempfile::TempDir,
        #[allow(dead_code)]
        work_dir: tempfile::TempDir,
        src: git2::Repository,
        work: git2::Repository,
        /// 双方共同的默认分支名（跟随机器 init.defaultBranch 配置）。
        branch: String,
    }

    /// 构造「源仓库 → 裸远程(origin) → 工作克隆」：源仓库当前分支已推送
    /// 一次，工作克隆检出该分支并跟踪 origin。返回各临时目录（保活）。
    fn setup_with_bare_remote() -> RemoteFixture {
        let origin_dir = tempfile::tempdir().expect("创建远程目录失败");
        git2::Repository::init_bare(origin_dir.path()).expect("初始化裸远程失败");

        let src_dir = tempfile::tempdir().expect("创建源仓库目录失败");
        let src = init_repo(src_dir.path());
        commit_file(&src, "a.txt", "v1\n", "initial");
        let branch = src
            .head()
            .expect("读取 HEAD 失败")
            .shorthand()
            .expect("HEAD 应为分支")
            .to_string();

        // 推送到裸远程（本地路径传输，无需凭证）。Remote 借用仓库，
        // 用块作用域在构造 RemoteFixture 前释放。
        let origin_url = origin_dir.path().to_string_lossy().into_owned();
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        {
            let mut remote = src.remote("origin", &origin_url).expect("配置远程失败");
            remote.push(&[refspec.as_str()], None).expect("推送失败");
        }

        // 克隆出工作仓库（git2 本地传输）。
        let work_dir = tempfile::tempdir().expect("创建工作仓库目录失败");
        let work = git2::Repository::clone(&origin_url, work_dir.path()).expect("克隆失败");

        RemoteFixture {
            origin_dir,
            src_dir,
            work_dir,
            src,
            work,
            branch,
        }
    }

    impl RemoteFixture {
        /// 源仓库追加提交并推送到裸远程，返回新提交 id。
        fn push_new_commit(&mut self) -> String {
            let oid = commit_file(&self.src, "a.txt", "v2\n", "remote update");
            let refspec = format!("refs/heads/{}:refs/heads/{}", self.branch, self.branch);
            let mut remote = self.src.find_remote("origin").expect("查找远程失败");
            remote.push(&[refspec.as_str()], None).expect("推送失败");
            oid
        }
        /// 工作仓库的 workdir 路径。
        fn workdir(&self) -> PathBuf {
            self.work.workdir().expect("应有工作区").to_path_buf()
        }

        /// 工作仓库 HEAD 提交 id。
        fn head_id(&self) -> String {
            self.work
                .head()
                .expect("读取 HEAD 失败")
                .peel_to_commit()
                .expect("解析 HEAD 失败")
                .id()
                .to_string()
        }
    }

    /// 远程跟踪引用 origin/<branch> 的 tip 提交 id。
    fn remote_tracking_tip(repo: &git2::Repository, branch: &str) -> String {
        repo.find_reference(&format!("refs/remotes/origin/{branch}"))
            .expect("远程跟踪引用应存在")
            .peel_to_commit()
            .expect("解析提交失败")
            .id()
            .to_string()
    }

    /// fetch：远程更新后，远程跟踪引用前进，HEAD 与工作区不动。
    #[test]
    fn fetch_updates_remote_tracking_ref_only() {
        let mut fx = setup_with_bare_remote();
        let head_before = fx.head_id();

        let c2 = fx.push_new_commit();
        let result = fetch(&fx.work, &fx.workdir(), None).expect("fetch 失败");
        assert_eq!(result.remote, "origin");

        assert_eq!(
            remote_tracking_tip(&fx.work, &fx.branch),
            c2,
            "远程跟踪引用应更新到新 tip"
        );
        assert_eq!(fx.head_id(), head_before, "fetch 不得移动 HEAD");
        assert_eq!(
            std::fs::read_to_string(fx.workdir().join("a.txt")).expect("读取 a.txt 失败"),
            "v1\n",
            "fetch 不得改动工作区"
        );

        // 幂等：再次 fetch 成功且引用不变。
        fetch(&fx.work, &fx.workdir(), None).expect("重复 fetch 失败");
        assert_eq!(remote_tracking_tip(&fx.work, &fx.branch), c2);
    }

    /// 显式指定远程名同样可行。
    #[test]
    fn fetch_explicit_remote() {
        let fx = setup_with_bare_remote();
        let result = fetch(&fx.work, &fx.workdir(), Some("origin")).expect("fetch 失败");
        assert_eq!(result.remote, "origin");
    }

    /// 显式远程名必须是已配置远程：选项串（--dry-run 等）与未配置名
    /// 均报 InvalidArg，不落到 git 参数。
    #[test]
    fn fetch_rejects_option_like_or_unknown_remote() {
        let fx = setup_with_bare_remote();
        for bad in [
            "--dry-run",
            "--upload-pack=touch /tmp/pwned",
            "no-such-remote",
        ] {
            match fetch(&fx.work, &fx.workdir(), Some(bad)) {
                Err(AppError::InvalidArg(_)) => {}
                Err(e) => panic!("期望 InvalidArg（{bad}），实际 {e:?}"),
                Ok(_) => panic!("非法远程名 {bad} 不应 fetch 成功"),
            }
        }
    }

    /// 无远程仓库 fetch → NotFound。
    #[test]
    fn fetch_without_remote_errors() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let repo = init_repo(dir.path());
        match fetch(&repo, dir.path(), None) {
            Err(AppError::NotFound(_)) => {}
            Err(e) => panic!("期望 NotFound，实际 {e:?}"),
            Ok(_) => panic!("无远程仓库不应 fetch 成功"),
        }
    }

    /// pull：fast-forward 到远程新提交，HEAD / 工作区 / 仓库信息一致。
    #[test]
    fn pull_fast_forwards_to_remote() {
        let mut fx = setup_with_bare_remote();
        let c2 = fx.push_new_commit();

        let result = pull(&fx.work, &fx.workdir()).expect("pull 失败");
        assert_eq!(fx.head_id(), c2, "HEAD 应 fast-forward 到远程新提交");
        assert_eq!(result.repo.head_commit, c2, "PullResult 应携带新 HEAD");
        assert!(
            result.repo.head_branch.is_some(),
            "pull 后应仍在分支上（非分离 HEAD）"
        );
        assert_eq!(
            std::fs::read_to_string(fx.workdir().join("a.txt")).expect("读取 a.txt 失败"),
            "v2\n",
            "工作区文件应更新为远程内容"
        );

        // 已经最新时再 pull 幂等。
        let again = pull(&fx.work, &fx.workdir()).expect("重复 pull 失败");
        assert_eq!(again.repo.head_commit, c2);
    }

    /// run_git：git 非零退出时错误消息包含 stderr 摘要。
    #[test]
    fn run_git_reports_failure() {
        let fx = setup_with_bare_remote();
        match run_git(&fx.workdir(), &["checkout", "no-such-branch"]) {
            Err(AppError::Git(msg)) => {
                assert!(
                    msg.contains("no-such-branch"),
                    "错误消息应含命令上下文: {msg}"
                );
            }
            Err(e) => panic!("期望 Git 错误，实际 {e:?}"),
            Ok(_) => panic!("非法分支切换不应成功"),
        }
    }

    /// normalize_output：\r 分隔的进度行拆行、空行过滤、超长截断。
    #[test]
    fn normalize_output_collapses_progress() {
        let stdout = "Receiving objects:  10%\rReceiving objects: 100%\r\nDone\n";
        let stderr = "\n\n";
        let normalized = normalize_output(stdout, stderr);
        assert_eq!(
            normalized,
            "Receiving objects:  10%\nReceiving objects: 100%\nDone"
        );

        let long = (0..80)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let normalized = normalize_output(&long, "");
        let count = normalized.lines().count();
        assert_eq!(
            count, MAX_OUTPUT_LINES,
            "应截断到尾部 {} 行",
            MAX_OUTPUT_LINES
        );
        assert!(normalized.ends_with("line79"), "应保留尾部行");
    }

    /// 固定 pull 策略（屏蔽机器全局 pull.rebase / pull.ff 配置的干扰）：
    /// 显式写入本地 pull.rebase=false，配合 [`pull_strategy_configured`]
    /// 的「已配置 → 不追加 --ff」分支，行为等价于显式 --ff 合并。
    fn pin_merge_strategy(repo: &git2::Repository) {
        let mut config = repo.config().expect("读取配置失败");
        config
            .set_bool("pull.rebase", false)
            .expect("固定 pull.rebase 失败");
    }

    /// pull：本地与远程发散且无 pull 策略配置时，以合并提交完成
    /// （不因 "Need to specify how to reconcile" 直接失败）。
    #[test]
    fn pull_divergent_without_strategy_merges() {
        let mut fx = setup_with_bare_remote();
        pin_merge_strategy(&fx.work);

        // 本地与远程各自前进（不同文件，避免冲突）。
        commit_file(&fx.work, "local.txt", "local\n", "local work");
        let local_before = fx.head_id();
        let remote_tip = fx.push_new_commit();

        let result = pull(&fx.work, &fx.workdir()).expect("发散 pull 失败");
        let head = fx
            .work
            .head()
            .expect("读取 HEAD 失败")
            .peel_to_commit()
            .expect("解析 HEAD 失败");
        assert_eq!(head.parent_count(), 2, "发散 pull 应产生双亲合并提交");
        let parents: Vec<String> = head.parent_ids().map(|o| o.to_string()).collect();
        assert!(parents.contains(&local_before), "第一亲应为原本地 tip");
        assert!(parents.contains(&remote_tip), "第二亲应为远程 tip");
        assert_eq!(result.repo.head_commit, head.id().to_string());
        assert!(fx.workdir().join("local.txt").exists(), "本地新文件应保留");
        assert_eq!(
            std::fs::read_to_string(fx.workdir().join("a.txt")).expect("读取 a.txt 失败"),
            "v2\n",
            "远程内容应合并进来"
        );
    }

    /// pull 冲突全流程：冲突报错但留下 MERGE_HEAD；解决 + 暂存 +
    /// create_commit 应记录双亲提交并收尾合并（清除 MERGE_HEAD 等状态）。
    #[test]
    fn conflicted_pull_then_commit_concludes_merge() {
        let mut fx = setup_with_bare_remote();
        pin_merge_strategy(&fx.work);

        // 本地与远程同时改 a.txt（内容不同）→ pull 冲突。
        commit_file(&fx.work, "a.txt", "local-change\n", "local conflicting");
        fx.push_new_commit(); // 远程：a.txt → v2

        match pull(&fx.work, &fx.workdir()) {
            Err(AppError::Git(_)) => {}
            Err(e) => panic!("期望 Git 冲突错误，实际 {e:?}"),
            Ok(_) => panic!("内容冲突的 pull 不应成功"),
        }
        assert!(
            fx.work.find_reference("MERGE_HEAD").is_ok(),
            "冲突 pull 应留下 MERGE_HEAD"
        );

        // 在应用内解决冲突：写合并结果 → 暂存 → 提交。
        std::fs::write(fx.workdir().join("a.txt"), "resolved\n").expect("写入解决内容失败");
        crate::git_service::stage_file(&mut fx.work, "a.txt").expect("暂存解决内容失败");
        let oid =
            crate::git_service::create_commit(&mut fx.work, "merge remote").expect("提交失败");

        let commit = fx
            .work
            .find_commit(git2::Oid::from_str(&oid).expect("oid 非法"))
            .expect("查找合并提交失败");
        assert_eq!(
            commit.parent_count(),
            2,
            "合并提交应有双亲（HEAD + MERGE_HEAD）"
        );
        assert!(
            fx.work.find_reference("MERGE_HEAD").is_err(),
            "提交后 MERGE_HEAD 应被清除"
        );
        assert!(
            !fx.work.path().join("MERGE_MSG").exists(),
            "MERGE_MSG 应被清除"
        );
        assert_eq!(
            std::fs::read_to_string(fx.workdir().join("a.txt")).expect("读取 a.txt 失败"),
            "resolved\n",
            "工作区应为解决后的内容"
        );
    }

    /// push：本地新提交推送到远程，远程跟踪引用前进。
    #[test]
    fn push_publishes_local_commit() {
        let fx = setup_with_bare_remote();
        let c2 = commit_file(&fx.work, "a.txt", "local-v2\n", "local work");

        let result = push(&fx.work, &fx.workdir()).expect("push 失败");
        assert_eq!(result.repo.head_commit, c2, "PushResult 应携带当前 HEAD");
        assert_eq!(
            remote_tracking_tip(&fx.work, &fx.branch),
            c2,
            "推送后远程跟踪引用应指向新提交"
        );
        // 幂等：无新提交时再推一次成功（Everything up-to-date）。
        push(&fx.work, &fx.workdir()).expect("重复 push 失败");
    }

    /// push：远端先行（非快进）时被拒并透传 git 错误，本地不受影响。
    #[test]
    fn push_rejects_non_fast_forward() {
        let mut fx = setup_with_bare_remote();
        let tracking_before = remote_tracking_tip(&fx.work, &fx.branch);
        // 远端先行一步（工作仓库未 fetch，跟踪引用仍停留在旧 tip）。
        fx.push_new_commit();
        // 本地基于旧 tip 造发散提交。
        let local = commit_file(&fx.work, "b.txt", "divergent\n", "local divergent");

        match push(&fx.work, &fx.workdir()) {
            Err(AppError::Git(msg)) => {
                assert!(
                    msg.to_lowercase().contains("rejected")
                        || msg.to_lowercase().contains("fetch first")
                        || msg.to_lowercase().contains("non-fast-forward"),
                    "错误消息应包含被拒原因: {msg}"
                );
            }
            Err(e) => panic!("期望 Git 错误，实际 {e:?}"),
            Ok(_) => panic!("非快进推送不应成功"),
        }
        assert_eq!(fx.head_id(), local, "失败的推送不应移动本地 HEAD");
        assert_eq!(
            remote_tracking_tip(&fx.work, &fx.branch),
            tracking_before,
            "失败的推送不应更新远程跟踪引用"
        );
    }

    /// push：当前分支无上游时自动 `--set-upstream` 推送并建立跟踪。
    #[test]
    fn push_without_upstream_sets_tracking() {
        let mut fx = setup_with_bare_remote();
        // 在本地新建分支 feat（无上游）并切过去。
        let tip = fx
            .work
            .head()
            .expect("读取 HEAD 失败")
            .peel_to_commit()
            .expect("解析 HEAD 失败");
        fx.work.branch("feat", &tip, false).expect("创建 feat 失败");
        drop(tip);
        crate::git_service::checkout_branch(&mut fx.work, "feat").expect("切换 feat 失败");
        let c2 = commit_file(&fx.work, "feat.txt", "feat\n", "on feat");

        push(&fx.work, &fx.workdir()).expect("无上游 push 失败");
        assert_eq!(
            remote_tracking_tip(&fx.work, "feat"),
            c2,
            "远程应出现 feat 分支并指向新提交"
        );
        // 跟踪配置已建立（再次 push 走普通路径）。
        let upstream = {
            let branch = fx
                .work
                .find_branch("feat", git2::BranchType::Local)
                .expect("feat 应存在");
            let up = branch.upstream().expect("上游应已配置");
            up.name().expect("上游名非法").map(str::to_string)
        };
        assert_eq!(upstream.as_deref(), Some("origin/feat"));
    }

    #[test]
    fn branch_tag_stash_and_reset_commands_work() {
        let mut fx = setup_with_bare_remote();
        let dir = fx.workdir();

        // create_branch & checkout
        let res = create_branch(&fx.work, &dir, "topic/ui", None, true).expect("create_branch 失败");
        assert_eq!(res.repo.head_branch.as_deref(), Some("topic/ui"));

        // commit + amend
        commit_file(&fx.work, "topic.txt", "v1\n", "wip");
        let amended = amend_commit(&fx.work, &dir, "feat: amended msg").expect("amend 失败");
        let topic_commit = amended.repo.head_commit.clone();
        let head_msg = fx
            .work
            .find_commit(git2::Oid::from_str(&topic_commit).unwrap())
            .unwrap()
            .message()
            .unwrap()
            .to_string();
        assert_eq!(head_msg.trim(), "feat: amended msg");

        // create_tag & push_tags
        create_tag(&fx.work, &dir, "v0.1.0", None).expect("create_tag 失败");
        push_tags(&fx.work, &dir).expect("push_tags 失败");

        // stash push / list / apply / drop
        std::fs::write(dir.join("untracked.txt"), "temp\n").unwrap();
        stash_push(&fx.work, &dir, Some("save temp")).expect("stash_push 失败");
        assert!(!dir.join("untracked.txt").exists());
        let stashes = list_stashes(&dir).expect("list_stashes 失败");
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].message.contains("save temp"));

        stash_apply(&fx.work, &dir, 0, false).expect("stash_apply 失败");
        assert!(dir.join("untracked.txt").exists());
        stash_drop(&fx.work, &dir, 0).expect("stash_drop 失败");
        assert!(list_stashes(&dir).unwrap().is_empty());

        // discard_file on untracked and tracked
        discard_file(&fx.work, &dir, "untracked.txt").expect("discard untracked 失败");
        assert!(!dir.join("untracked.txt").exists());
        std::fs::write(dir.join("topic.txt"), "dirty\n").unwrap();
        discard_file(&fx.work, &dir, "topic.txt").expect("discard tracked 失败");
        assert_eq!(std::fs::read_to_string(dir.join("topic.txt")).unwrap(), "v1\n");

        // checkout main branch, merge topic/ui, revert, reset, delete_branch
        let main_branch = fx.branch.clone();
        crate::git_service::checkout_branch(&mut fx.work, &main_branch).expect("切回主分支失败");
        merge_branch(&fx.work, &dir, "topic/ui").expect("merge_branch 失败");
        assert_eq!(fx.head_id(), topic_commit);

        revert_commit(&fx.work, &dir, &topic_commit).expect("revert_commit 失败");
        assert!(!dir.join("topic.txt").exists());

        reset_head(&fx.work, &dir, "HEAD~1", "mixed").expect("reset_head 失败");
        assert_eq!(fx.head_id(), topic_commit);

        delete_branch(&fx.work, &dir, "topic/ui", false).expect("delete_branch 失败");

        // reject option injection & traversal
        assert!(matches!(
            create_branch(&fx.work, &dir, "--bad", None, true),
            Err(AppError::InvalidArg(_))
        ));
        assert!(matches!(
            discard_file(&fx.work, &dir, "../escape.txt"),
            Err(AppError::InvalidArg(_))
        ));
        assert!(matches!(
            reset_head(&fx.work, &dir, "HEAD", "unknown"),
            Err(AppError::InvalidArg(_))
        ));
    }
}
