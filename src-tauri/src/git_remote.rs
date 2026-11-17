//! Git 远程操作：fetch / pull 通过 git CLI 子进程执行（README Phase 3、docs/04 §8）。
//!
//! 走 CLI 而非 git2-rs 网络栈的原因：完整复用系统 git 的凭证链路
//! （SSH agent、`~/.ssh/config`、macOS Keychain 凭证助手等），避免在
//! 应用内重新实现认证。读操作（分支列表等）仍走 git2-rs。
//!
//! 约定：
//! - 子进程设置 `GIT_TERMINAL_PROMPT=0` 与 `GIT_EDITOR=true`：GUI 进程
//!   没有终端，避免凭证提示或编辑器挂死；
//! - pull 固定 `--no-edit`：避免无终端环境下合并提交信息编辑器挂起；
//! - 显式传入的远程名必须是仓库已配置的远程，防止 `--all` /
//!   `--upload-pack=…` 等以选项形式注入 git 参数；
//! - 输出按 `\r`/`\n` 拆行规整（fetch 进度以 `\r` 刷新会产生大量行），
//!   并截断到尾部若干行，防止巨型载荷走 IPC；
//! - 远程操作支持流式读取 stderr 进度行与按 `repo_id` 取消（向子进程组发送
//!   SIGTERM/SIGKILL，立即中止 git 及其 ssh/http 辅助进程）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::git_service;
use crate::types::{FetchResult, GitActionResult, PullResult, PushResult, RepoState, StashEntry};

/// 返回给前端的输出摘要行数上限。
const MAX_OUTPUT_LINES: usize = 50;
/// 流式进度事件最小发送间隔（避免高频 `\r` 刷爆 IPC）。
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(80);
/// 提交签名回退用户名（仓库与全局配置均缺失时）。
const FALLBACK_SIGNATURE_NAME: &str = "OpenPatchline";
const FALLBACK_SIGNATURE_EMAIL: &str = "openpatchline@local";

/// git 可执行文件候选：GUI 进程（从 Finder/Dock 启动）不继承 shell 的
/// PATH，Homebrew 安装的 git 可能不在默认 PATH 里；依次回退常见位置。
const GIT_BIN_CANDIDATES: &[&str] = &["git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];

/// 用户在设置中覆盖的 git 可执行文件路径（docs/11 §三 6.2）；
/// 配置后优先于候选列表使用，路径无效时如实报错而不是静默回退。
static GIT_BIN_OVERRIDE: RwLock<Option<String>> = RwLock::new(None);

/// 更新 git 可执行文件覆盖路径；空串等价于清除覆盖。
pub fn set_git_bin_override(path: Option<&str>) {
    let normalized = path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Ok(mut guard) = GIT_BIN_OVERRIDE.write() {
        *guard = normalized;
    }
}

/// 读取当前生效的 git 可执行文件覆盖路径（设置页展示用）。
pub fn git_bin_override() -> Option<String> {
    GIT_BIN_OVERRIDE.read().ok().and_then(|g| g.clone())
}

static NEXT_OP_ID: AtomicU64 = AtomicU64::new(1);

struct ActiveRemoteProcess {
    op_id: u64,
    cancelled: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

/// 跟踪各仓库正在执行的远程 git 子进程，支持无锁等待的即时取消。
#[derive(Clone, Default)]
pub struct RemoteOpManager {
    active: Arc<Mutex<HashMap<String, ActiveRemoteProcess>>>,
}

impl RemoteOpManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn register(
        &self,
        repo_id: &str,
        child: Child,
    ) -> (u64, Arc<AtomicBool>, Arc<Mutex<Option<Child>>>) {
        let op_id = NEXT_OP_ID.fetch_add(1, Ordering::Relaxed);
        let cancelled = Arc::new(AtomicBool::new(false));
        let child_arc = Arc::new(Mutex::new(Some(child)));
        self.active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                repo_id.to_string(),
                ActiveRemoteProcess {
                    op_id,
                    cancelled: Arc::clone(&cancelled),
                    child: Arc::clone(&child_arc),
                },
            );
        (op_id, cancelled, child_arc)
    }

    fn unregister(&self, repo_id: &str, op_id: u64) {
        let mut map = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if map.get(repo_id).is_some_and(|p| p.op_id == op_id) {
            map.remove(repo_id);
        }
    }

    /// 中止指定仓库正在运行的远程子进程（及 Unix 进程组中的辅助进程）。
    pub fn cancel(&self, repo_id: &str) -> bool {
        let entry = {
            let map = self.active.lock().unwrap_or_else(|p| p.into_inner());
            map.get(repo_id)
                .map(|p| (Arc::clone(&p.cancelled), Arc::clone(&p.child)))
        };
        let Some((cancelled, child_arc)) = entry else {
            return false;
        };
        cancelled.store(true, Ordering::SeqCst);
        let mut guard = child_arc.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(child) = guard.as_mut() {
            terminate_process_tree(child);
        }
        true
    }
}

/// 终止子进程及其子孙进程组，避免 ssh / git-remote-https 残留持有管道。
fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let pgid = format!("-{}", child.id());
        let _ = Command::new("/bin/kill").args(["-TERM", &pgid]).status();
        std::thread::sleep(Duration::from_millis(80));
        if matches!(child.try_wait(), Ok(None)) {
            let _ = Command::new("/bin/kill").args(["-KILL", &pgid]).status();
            let _ = child.kill();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

struct ActiveOpGuard<'a> {
    manager: &'a RemoteOpManager,
    repo_id: String,
    op_id: u64,
}

impl Drop for ActiveOpGuard<'_> {
    fn drop(&mut self) {
        self.manager.unregister(&self.repo_id, self.op_id);
    }
}

/// 远程流式执行上下文（进度回调 + 取消管理器）。
pub struct RemoteProgress<'a> {
    pub manager: &'a RemoteOpManager,
    pub repo_id: &'a str,
    pub on_line: &'a (dyn Fn(&str, Option<u8>) + Send + Sync),
}

/// 从 git 进度行提取百分比（如 `"Receiving objects:  45% (9/20)"` → `Some(45)`）。
pub fn parse_progress_percent(line: &str) -> Option<u8> {
    let pct_idx = line.find('%')?;
    let digits = line[..pct_idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    let val = digits
        .chars()
        .rev()
        .collect::<String>()
        .parse::<u8>()
        .ok()?;
    (val <= 100).then_some(val)
}

/// 启动 `git <args..>` 子进程，配置非交互环境变量与独立进程组。
fn spawn_git_command_with_stdin(
    workdir: &Path,
    args: &[&str],
    pipe_stdin: bool,
) -> AppResult<Child> {
    spawn_git_command_with_envs(workdir, args, pipe_stdin, &[])
}

/// [`spawn_git_command_with_stdin`] 的扩展版本：追加覆盖型环境变量
/// （如交互式变基的 GIT_SEQUENCE_EDITOR / GIT_EDITOR，v0.7 / 7.3）。
fn spawn_git_command_with_envs(
    workdir: &Path,
    args: &[&str],
    pipe_stdin: bool,
    extra_envs: &[(&str, &str)],
) -> AppResult<Child> {
    if let Some(bin) = git_bin_override() {
        let mut cmd = Command::new(&bin);
        cmd.current_dir(workdir)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "true")
            .envs(extra_envs.iter().map(|(k, v)| (*k, *v)))
            .stdin(if pipe_stdin {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        return match cmd.spawn() {
            Ok(child) => Ok(child),
            Err(e) => Err(AppError::Io(format!(
                "无法启动设置中指定的 git 可执行文件 {bin}: {e}；请在设置中修正 Git 路径"
            ))),
        };
    }
    for bin in GIT_BIN_CANDIDATES {
        let mut cmd = Command::new(bin);
        cmd.current_dir(workdir)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "true")
            .envs(extra_envs.iter().map(|(k, v)| (*k, *v)))
            .stdin(if pipe_stdin {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            // 候选不存在（NotFound）→ 尝试下一个；其他错误（权限等）如实上报。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::Io(format!("启动 git 子进程失败: {e}"))),
        }
    }
    Err(AppError::Io(format!(
        "找不到 git 可执行文件（已尝试 {}）；请安装 git CLI（xcode-select --install）",
        GIT_BIN_CANDIDATES.join(", "),
    )))
}

/// 流式读取字节流并按 `\r`/`\n` 分行回调，同时收集完整原始字节。
fn drain_stream<R: Read>(mut reader: R, mut on_line: impl FnMut(&str)) -> Vec<u8> {
    let mut all = Vec::new();
    let mut line_buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(n) = reader.read(&mut chunk) {
        if n == 0 {
            break;
        }
        all.extend_from_slice(&chunk[..n]);
        for &b in &chunk[..n] {
            if b == b'\r' || b == b'\n' {
                if !line_buf.is_empty() {
                    let s = String::from_utf8_lossy(&line_buf);
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        on_line(trimmed);
                    }
                    line_buf.clear();
                }
            } else {
                line_buf.push(b);
            }
        }
    }
    if !line_buf.is_empty() {
        let s = String::from_utf8_lossy(&line_buf);
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            on_line(trimmed);
        }
    }
    all
}

/// 在 `workdir` 下运行 `git <args..>` 子进程，可选流式读取进度与取消支持。
fn run_git_raw_with(
    workdir: &Path,
    args: &[&str],
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<(String, String)> {
    let mut child = spawn_git_command_with_stdin(workdir, args, false)?;
    let Some(progress) = progress else {
        let output = child
            .wait_with_output()
            .map_err(|e| AppError::Io(format!("等待 git 子进程失败: {e}")))?;
        return finish_git_output(
            args,
            output.status.success(),
            output.stdout,
            output.stderr,
            false,
        );
    };

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let (op_id, cancelled, child_arc) = progress.manager.register(progress.repo_id, child);
    let _guard = ActiveOpGuard {
        manager: progress.manager,
        repo_id: progress.repo_id.to_string(),
        op_id,
    };

    let last_emit = Mutex::new(Instant::now() - PROGRESS_EMIT_INTERVAL);
    let emit_line = |line: &str| {
        let pct = parse_progress_percent(line);
        let force = pct == Some(100) || line.ends_with("done.");
        let mut guard = last_emit.lock().unwrap_or_else(|p| p.into_inner());
        if force || guard.elapsed() >= PROGRESS_EMIT_INTERVAL {
            *guard = Instant::now();
            drop(guard);
            (progress.on_line)(line, pct);
        }
    };

    let (stdout_bytes, stderr_bytes) = std::thread::scope(|s| {
        let t_out = s.spawn(|| match stdout_pipe {
            Some(r) => drain_stream(r, |_| {}),
            None => Vec::new(),
        });
        let t_err = s.spawn(|| match stderr_pipe {
            Some(r) => drain_stream(r, |line| emit_line(line)),
            None => Vec::new(),
        });
        (
            t_out.join().unwrap_or_default(),
            t_err.join().unwrap_or_default(),
        )
    });

    let status = {
        let mut guard = child_arc.lock().unwrap_or_else(|p| p.into_inner());
        match guard.take() {
            Some(mut c) => c
                .wait()
                .map_err(|e| AppError::Io(format!("等待 git 子进程失败: {e}")))?,
            None => {
                return Err(AppError::Unexpected("子进程句柄丢失".to_string()));
            }
        }
    };

    finish_git_output(
        args,
        status.success(),
        stdout_bytes,
        stderr_bytes,
        cancelled.load(Ordering::SeqCst),
    )
}

fn finish_git_output(
    args: &[&str],
    success: bool,
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
    was_cancelled: bool,
) -> AppResult<(String, String)> {
    if was_cancelled {
        return Err(AppError::Cancelled);
    }
    let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
    if !success {
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

/// 在 `workdir` 下运行 `git <args..>` 子进程，可选通过 stdin 传入字节载荷，返回原始 `(stdout, stderr)`。
pub(crate) fn run_git_with_input(
    workdir: &Path,
    args: &[&str],
    stdin_data: Option<&[u8]>,
) -> AppResult<(String, String)> {
    let Some(bytes) = stdin_data else {
        return run_git_raw_with(workdir, args, None);
    };
    let mut child = spawn_git_command_with_stdin(workdir, args, true)?;
    let stdin_pipe = child.stdin.take();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let (write_res, stdout_bytes, stderr_bytes) = std::thread::scope(|s| {
        let t_in = s.spawn(move || -> std::io::Result<()> {
            if let Some(mut w) = stdin_pipe {
                w.write_all(bytes)?;
                w.flush()?;
            }
            Ok(())
        });
        let t_out = s.spawn(|| match stdout_pipe {
            Some(r) => drain_stream(r, |_| {}),
            None => Vec::new(),
        });
        let t_err = s.spawn(|| match stderr_pipe {
            Some(r) => drain_stream(r, |_| {}),
            None => Vec::new(),
        });
        (
            t_in.join()
                .unwrap_or_else(|_| Err(std::io::Error::other("stdin 写入线程异常退出"))),
            t_out.join().unwrap_or_default(),
            t_err.join().unwrap_or_default(),
        )
    });
    let status = child
        .wait()
        .map_err(|e| AppError::Io(format!("等待 git 子进程失败: {e}")))?;
    if status.success()
        && let Err(e) = write_res
    {
        return Err(AppError::Io(format!("向 git 子进程写入 stdin 失败: {e}")));
    }
    finish_git_output(args, status.success(), stdout_bytes, stderr_bytes, false)
}

/// 在 `workdir` 下运行 `git <args..>` 子进程，返回原始 `(stdout, stderr)`。
fn run_git_raw(workdir: &Path, args: &[&str]) -> AppResult<(String, String)> {
    run_git_raw_with(workdir, args, None)
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

/// [`run_git`] 的 crate 内入口（git_service::history 委托 `git log --follow`
/// 用，review 修复 #3 / #10）。
pub(crate) fn run_git_for_service(workdir: &Path, args: &[&str]) -> AppResult<String> {
    run_git(workdir, args)
}

fn run_git_streaming(
    workdir: &Path,
    args: &[&str],
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<String> {
    let (stdout, stderr) = run_git_raw_with(workdir, args, progress)?;
    Ok(normalize_output(&stdout, &stderr))
}

/// 运行 git 并返回 (是否成功, 规整输出)；非零退出不转为 Err（继续操作多轮冲突时
/// 退出码非零但操作仍在进行，需要据仓库状态而非退出码判断进度）。
fn run_git_tolerant(
    workdir: &Path,
    args: &[&str],
    extra_envs: &[(&str, &str)],
) -> AppResult<(bool, String)> {
    let child = spawn_git_command_with_envs(workdir, args, false, extra_envs)?;
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Io(format!("等待 git 子进程失败: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Ok((output.status.success(), normalize_output(&stdout, &stderr)))
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
    fetch_with_progress(repo, workdir, remote, None)
}

/// 流式拉取（支持进度推送与取消）。
pub fn fetch_with_progress(
    repo: &git2::Repository,
    workdir: &Path,
    remote: Option<&str>,
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<FetchResult> {
    let remote_name = default_remote(repo, remote)?;
    let output = run_git_streaming(
        workdir,
        &["fetch", "--progress", "--prune", &remote_name],
        progress,
    )?;
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
pub fn pull(repo: &git2::Repository, workdir: &Path) -> AppResult<PullResult> {
    pull_with_progress(repo, workdir, None)
}

/// 流式拉取并合并到当前分支（支持进度推送与取消）。
pub fn pull_with_progress(
    repo: &git2::Repository,
    workdir: &Path,
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<PullResult> {
    let mut args: Vec<&str> = vec!["pull", "--progress", "--no-edit"];
    if !pull_strategy_configured(repo) {
        args.push("--ff");
    }
    let output = run_git_streaming(workdir, &args, progress)?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PullResult {
        output,
        repo: repo_info,
    })
}

/// 构造推送当前分支的公共逻辑（支持 `--force-with-lease` 等附加参数）。
fn push_branch_with(
    repo: &git2::Repository,
    workdir: &Path,
    extra_flag: Option<&str>,
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<PushResult> {
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
    let mut args: Vec<&str> = vec!["push", "--progress"];
    if let Some(flag) = extra_flag {
        args.push(flag);
    }
    if !has_upstream {
        args.extend(["--set-upstream", remote_name.as_str(), branch.as_str()]);
    }
    let output = run_git_streaming(workdir, &args, progress)?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PushResult {
        output,
        repo: repo_info,
    })
}

/// 推送当前分支（push）。
pub fn push(repo: &git2::Repository, workdir: &Path) -> AppResult<PushResult> {
    push_with_progress(repo, workdir, None)
}

/// 流式推送当前分支（支持进度推送与取消）。
pub fn push_with_progress(
    repo: &git2::Repository,
    workdir: &Path,
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<PushResult> {
    push_branch_with(repo, workdir, None, progress)
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
    fetch_all_with_progress(repo, workdir, None)
}

/// 流式拉取全部远程（支持进度推送与取消）。
pub fn fetch_all_with_progress(
    repo: &git2::Repository,
    workdir: &Path,
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<GitActionResult> {
    let names = remote_names(repo)?;
    if names.is_empty() {
        return Err(AppError::NotFound(
            "仓库没有配置远程（remote），无法拉取".to_string(),
        ));
    }
    let output = run_git_streaming(
        workdir,
        &["fetch", "--all", "--prune", "--progress"],
        progress,
    )?;
    action_result(repo, output)
}

/// 使用 rebase + autostash 策略拉取并重放当前分支（`git pull --rebase --autostash --no-edit`）。
pub fn pull_rebase(repo: &git2::Repository, workdir: &Path) -> AppResult<PullResult> {
    pull_rebase_with_progress(repo, workdir, None)
}

/// 流式 rebase 拉取（支持进度推送与取消）。
pub fn pull_rebase_with_progress(
    repo: &git2::Repository,
    workdir: &Path,
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<PullResult> {
    let output = run_git_streaming(
        workdir,
        &["pull", "--rebase", "--autostash", "--no-edit", "--progress"],
        progress,
    )?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PullResult {
        output,
        repo: repo_info,
    })
}

/// 安全强推当前分支（`git push --force-with-lease`；无上游时自动 `--set-upstream`）。
pub fn push_force_with_lease(repo: &git2::Repository, workdir: &Path) -> AppResult<PushResult> {
    push_force_with_lease_with_progress(repo, workdir, None)
}

/// 流式安全强推当前分支（支持进度推送与取消）。
pub fn push_force_with_lease_with_progress(
    repo: &git2::Repository,
    workdir: &Path,
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<PushResult> {
    push_branch_with(repo, workdir, Some("--force-with-lease"), progress)
}

/// 推送所有本地标签到默认远程（`git push <remote> --tags`）。
pub fn push_tags(repo: &git2::Repository, workdir: &Path) -> AppResult<PushResult> {
    push_tags_with_progress(repo, workdir, None)
}

/// 流式推送所有本地标签（支持进度推送与取消）。
pub fn push_tags_with_progress(
    repo: &git2::Repository,
    workdir: &Path,
    progress: Option<RemoteProgress<'_>>,
) -> AppResult<PushResult> {
    let remote_name = default_remote(repo, None)?;
    let output = run_git_streaming(
        workdir,
        &["push", "--progress", remote_name.as_str(), "--tags"],
        progress,
    )?;
    let repo_info = git_service::repo_info(repo)?;
    Ok(PushResult {
        output,
        repo: repo_info,
    })
}

/// 中止进行中的合并 / 变基 / cherry-pick / revert，恢复到操作前状态。
pub fn abort_operation(repo: &git2::Repository, workdir: &Path) -> AppResult<GitActionResult> {
    let args: &[&str] = match git_service::repo_state(repo) {
        RepoState::Merging => &["merge", "--abort"],
        RepoState::Rebasing => &["rebase", "--abort"],
        RepoState::CherryPicking => &["cherry-pick", "--abort"],
        RepoState::Reverting => &["revert", "--abort"],
        RepoState::Applying => &["am", "--abort"],
        RepoState::Bisecting => &["bisect", "reset"],
        RepoState::Clean => {
            return Err(AppError::InvalidArg(
                "当前仓库没有进行中的合并、变基或挑选操作".to_string(),
            ));
        }
    };
    let output = run_git(workdir, args)?;
    // 中止成功 → 变基已结束，清理交互式变基的持久编辑器目录
    //（含 merge/cherry-pick 等其他操作中止时顺带清掉历史残留，无则 no-op）。
    cleanup_rebase_editor(repo);
    action_result(repo, output)
}

/// 解决冲突后继续进行中的合并 / 变基 / cherry-pick / revert。
pub fn continue_operation(repo: &git2::Repository, workdir: &Path) -> AppResult<GitActionResult> {
    let index = git_service::fresh_index(repo)?;
    if index.has_conflicts() {
        return Err(AppError::Git(
            "仍有未解决的冲突文件，请先解决冲突并标记为已解决".to_string(),
        ));
    }
    let state = git_service::repo_state(repo);
    let args: &[&str] = match state {
        RepoState::Merging => &["merge", "--continue"],
        RepoState::Rebasing => &["rebase", "--continue"],
        RepoState::CherryPicking => &["cherry-pick", "--continue"],
        RepoState::Reverting => &["revert", "--continue"],
        RepoState::Applying => &["am", "--continue"],
        RepoState::Clean | RepoState::Bisecting => {
            return Err(AppError::InvalidArg("当前仓库没有可继续的操作".to_string()));
        }
    };
    // 变基进行中且存在持久编辑器（交互式变基暂停）→ 继续沿用同一
    // GIT_EDITOR，保证冲突之后未消费的 Reword/Squash 说明仍被写入
    // （review 修复 #2；否则退化为 GIT_EDITOR=true 丢失用户文案）。
    let editor_path = rebase_editor_dir(repo).join("editor.sh");
    let editor_str = editor_path.display().to_string();
    let mut envs: Vec<(&str, &str)> = Vec::new();
    if state == RepoState::Rebasing && editor_path.is_file() {
        envs.push(("GIT_EDITOR", editor_str.as_str()));
    }
    let (ok, output) = run_git_tolerant(workdir, args, &envs)?;
    if ok {
        // 操作完成 → 清理交互式变基的持久编辑器目录。
        if git_service::repo_state(repo) == RepoState::Clean {
            cleanup_rebase_editor(repo);
        }
        return action_result(repo, output);
    }
    let now = git_service::repo_state(repo);
    if now == RepoState::Clean {
        // 退出码非零但操作已完成（个别 git 版本的警告性退出）→ 视为完成。
        cleanup_rebase_editor(repo);
        return action_result(repo, output);
    }
    // 仍在原操作中：仅当出现了新的冲突（index 含冲突条目）才视为
    // 「推进到下一步并再次冲突」（v0.7 / 7.3 多轮冲突）；否则为真实
    // 失败（钩子拒绝、空说明等），如实报错（review 修复 #2 附带）。
    let has_new_conflicts = git_service::fresh_index(repo)
        .map(|i| i.has_conflicts())
        .unwrap_or(false);
    if now == state && has_new_conflicts {
        return action_result(
            repo,
            format!("{output}\n（仍有待处理步骤，请继续解决冲突后再次「继续」）"),
        );
    }
    Err(AppError::Git(format!(
        "git {} 失败:\n{}",
        args.join(" "),
        output.trim()
    )))
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
            )));
        }
    };
    let rev = validate_target_ref(repo, target, "重置目标")?;
    let output = run_git(workdir, &["reset", mode_flag, rev])?;
    action_result(repo, output)
}

/// 丢弃单个未暂存或未跟踪文件的更改（保留已暂存修改）。
///
/// - 校验路径为仓库工作区内合法相对路径（禁止 `..`、绝对路径与父目录符号链接逃逸）；
/// - 处于冲突状态的文件拒绝直接丢弃；
/// - 已存在于暂存区（index stage 0）的文件执行 `git checkout -- <path>`，从暂存区恢复工作区而不覆盖已暂存修改；
/// - 不在暂存区的文件（未跟踪文件，或已暂存删除但工作区又新建的同名文件）仅删除工作区条目。
pub fn discard_file(repo: &git2::Repository, workdir: &Path, path: &str) -> AppResult<()> {
    let rel = git_service::validate_rel_path(path)?;
    let full = git_service::resolve_workdir_path(workdir, path)?;
    let index = git_service::fresh_index(repo)?;

    if (1..=3).any(|stage| index.get_path(rel, stage).is_some()) {
        return Err(AppError::InvalidArg(format!(
            "文件 {path} 存在未解决冲突，请先解决冲突后再操作"
        )));
    }

    if index.get_path(rel, 0).is_some() {
        run_git(workdir, &["checkout", "--", path])?;
    } else if let Ok(meta) = std::fs::symlink_metadata(&full) {
        if meta.is_dir() && !meta.file_type().is_symlink() {
            std::fs::remove_dir_all(&full)
                .map_err(|e| AppError::Io(format!("删除未跟踪目录 {path} 失败: {e}")))?;
        } else {
            std::fs::remove_file(&full)
                .map_err(|e| AppError::Io(format!("删除未跟踪文件 {path} 失败: {e}")))?;
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

/// 基于贮藏条目创建并切换分支（`git stash branch <name> stash@{n}`，v0.7 / 7.4）：
/// 在贮藏时的基准提交上建分支、检出并应用贮藏，成功后自动弹出该条目。
pub fn stash_branch(
    repo: &git2::Repository,
    workdir: &Path,
    name: &str,
    index: usize,
) -> AppResult<GitActionResult> {
    let name = name.trim();
    if name.is_empty() || name.chars().any(char::is_whitespace) {
        return Err(AppError::InvalidArg("分支名不能包含空白字符".to_string()));
    }
    let stash_ref = format!("stash@{{{index}}}");
    let output = run_git(workdir, &["stash", "branch", name, &stash_ref])?;
    action_result(repo, output)
}

// ---------------------------------------------------------------------------
// 交互式变基（v0.7 / 7.3）
// ---------------------------------------------------------------------------

/// 变基前备份引用：始终指向最近一次交互式变基开始前的分支头。
pub const REBASE_BACKUP_REF: &str = "refs/opl-backup/rebase";

/// 变基编辑器持久目录（.git/opl-rebase-editor/，review 修复 #2）：
/// 冲突暂停时 GIT_EDITOR 脚本与说明文件必须存活到 `rebase --continue`
/// 完成，tempfile::TempDir 会在函数返回时删除，故放在 .git 下；
/// 变基完成或中止时清理。
fn rebase_editor_dir(repo: &git2::Repository) -> PathBuf {
    repo.path().join("opl-rebase-editor")
}

/// 清理变基编辑器持久目录（若存在）。
fn cleanup_rebase_editor(repo: &git2::Repository) {
    let dir = rebase_editor_dir(repo);
    if dir.is_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// 允许一次性整理的最大提交数量（与轻量路径保持一致）。
const MAX_INTERACTIVE_REBASE: usize = 50;

/// 交互式变基（v0.7 / 7.3）：Pick / Reword / Squash / Fixup / Drop + 任意顺序。
///
/// - 无重排且无丢弃时走 [`git_service::rewrite_recent_commits`] 的无冲突
///   轻量路径（数学上不会冲突）；
/// - 含重排或丢弃时委托 `git rebase -i` + `GIT_SEQUENCE_EDITOR`（todo 由
///   本函数生成，git 自身不再弹出编辑器；Reword/Squash 的说明经
///   `GIT_EDITOR` 脚本按调用次序写入）；
/// - 两种路径执行前都会把当前分支头记录到 [`REBASE_BACKUP_REF`]；
/// - 变基中途冲突：仓库进入 Rebasing 状态并返回 Ok（前端走既有的
///   冲突编辑器 + 继续 / 中止链路，Continue/Abort 均不丢失提交）。
pub fn interactive_rebase(
    repo: &mut git2::Repository,
    workdir: &Path,
    plan: &[crate::types::RebasePlanEntry],
) -> AppResult<GitActionResult> {
    if plan.is_empty() {
        return Err(AppError::InvalidArg("提交整理计划不能为空".to_string()));
    }
    if plan.len() > MAX_INTERACTIVE_REBASE {
        return Err(AppError::InvalidArg(format!(
            "单次最多整理 {MAX_INTERACTIVE_REBASE} 个最近提交"
        )));
    }

    // 读取自 HEAD 起连续 plan.len() 个线性提交（原顺序，旧 → 新）。
    let (head_oid, head_first_parent_walk) = {
        let head_commit = repo
            .head()
            .map_err(|e| AppError::NotFound(format!("HEAD 不可用，无法整理提交: {e}")))?
            .peel_to_commit()
            .map_err(|e| AppError::Git(format!("解析 HEAD 提交失败: {e}")))?;
        (head_commit.id(), head_commit)
    };
    let mut chain: Vec<git2::Oid> = Vec::with_capacity(plan.len());
    let mut cur = head_first_parent_walk;
    for step in 0..plan.len() {
        if cur.parent_count() > 1 {
            return Err(AppError::InvalidArg(
                "选定范围包含合并提交（merge commit），不支持交互式整理".to_string(),
            ));
        }
        chain.push(cur.id());
        if step + 1 < plan.len() {
            if cur.parent_count() == 0 {
                return Err(AppError::InvalidArg(
                    "提交数量超过仓库根提交，历史长度不匹配，请刷新后重试".to_string(),
                ));
            }
            cur = cur
                .parent(0)
                .map_err(|e| AppError::Git(format!("读取父提交失败: {e}")))?;
        }
    }
    chain.reverse(); // 旧 → 新

    // 计划必须恰好覆盖该段历史（集合一致），显式丢弃须用 Drop 表达。
    let mut plan_sorted: Vec<&str> = plan.iter().map(|e| e.commit_id.as_str()).collect();
    let mut chain_sorted: Vec<String> = chain.iter().map(|o| o.to_string()).collect();
    plan_sorted.sort();
    chain_sorted.sort();
    if plan_sorted != chain_sorted {
        return Err(AppError::InvalidArg(
            "整理计划与当前 HEAD 最近提交不一致，请刷新后重试".to_string(),
        ));
    }

    // 第一条非 Drop 的动作不能是 Squash/Fixup（Drop 不算可合并的前置提交，
    // review 修复 #7：否则 git rebase -i 中止报错甚至停在变基中）。
    if let Some(first_kept) = plan
        .iter()
        .find(|e| !matches!(e.action, crate::types::RebaseAction::Drop))
        && matches!(
            first_kept.action,
            crate::types::RebaseAction::Squash | crate::types::RebaseAction::Fixup
        )
    {
        return Err(AppError::InvalidArg(
            "第一条保留的提交不能设为压缩（Squash/Fixup）：丢弃的提交不可作为合并目标，请先将其下移或改为保留".to_string(),
        ));
    }

    // 备份引用：两种路径统一先落盘（不丢失提交的保险，验收项）。
    drop(cur);
    repo.reference(
        REBASE_BACKUP_REF,
        head_oid,
        true,
        "openpatchline: backup before interactive rebase",
    )
    .map_err(|e| AppError::Git(format!("创建备份引用失败: {e}")))?;

    // 无重排且无 Drop → 轻量无冲突路径。
    let order_preserved = plan
        .iter()
        .zip(chain.iter())
        .all(|(e, oid)| e.commit_id == oid.to_string());
    let has_drop = plan
        .iter()
        .any(|e| matches!(e.action, crate::types::RebaseAction::Drop));
    if order_preserved && !has_drop {
        let new_head = git_service::rewrite_recent_commits(repo, plan)?;
        let output = format!(
            "已按无冲突轻量路径整理 {n} 条提交；原 HEAD 备份于 {REBASE_BACKUP_REF}（{old}）",
            n = plan.len(),
            old = &head_oid.to_string()[..7],
        );
        let _ = new_head;
        return action_result(repo, output);
    }

    // —— 构造 todo 与编辑器脚本（持久化到 .git 下，冲突暂停后仍可用）——
    cleanup_rebase_editor(repo);
    let dir = rebase_editor_dir(repo);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Io(format!("创建变基编辑器目录失败: {e}")))?;
    let mut todo_lines: Vec<String> = Vec::new();
    // 编辑器消息队列：Reword / Squash 依序消耗。
    let mut editor_messages: Vec<String> = Vec::new();
    // 当前合并分组的说明（Squash 默认合并文案用）。
    let mut group_message = String::new();

    for entry in plan {
        let oid = git2::Oid::from_str(&entry.commit_id)
            .map_err(|e| AppError::InvalidArg(format!("提交 id 非法: {e}")))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| AppError::Git(format!("读取提交 {oid} 失败: {e}")))?;
        let raw_msg = commit.message().unwrap_or_default().trim_end_matches('\n');
        let _subject = raw_msg.lines().next().unwrap_or_default();
        let custom = entry
            .message
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        use crate::types::RebaseAction;
        match entry.action {
            RebaseAction::Pick => {
                todo_lines.push(format!("pick {oid}"));
                group_message = raw_msg.to_string();
            }
            RebaseAction::Reword => {
                let msg = custom.ok_or_else(|| {
                    AppError::InvalidArg("改写说明（Reword）的提交信息不能为空".to_string())
                })?;
                todo_lines.push(format!("reword {oid}"));
                editor_messages.push(msg.to_string());
                group_message = msg.to_string();
            }
            RebaseAction::Squash => {
                // 无自定义文案时沿用既有轻量路径语义：合并两侧说明。
                let combined = match custom {
                    Some(m) => m.to_string(),
                    None => {
                        let mut c = group_message.clone();
                        if !c.is_empty() {
                            c.push_str("\n\n");
                        }
                        c.push_str(raw_msg);
                        c
                    }
                };
                todo_lines.push(format!("squash {oid}"));
                editor_messages.push(combined.clone());
                group_message = combined;
            }
            RebaseAction::Fixup => {
                todo_lines.push(format!("fixup {oid}"));
                // 分组说明保持不变。
            }
            RebaseAction::Drop => {
                todo_lines.push(format!("drop {oid}"));
            }
        }
    }

    let todo_path = dir.join("todo");
    std::fs::write(&todo_path, format!("{}\n", todo_lines.join("\n")))
        .map_err(|e| AppError::Io(format!("写入变基 todo 失败: {e}")))?;

    // GIT_EDITOR 脚本：第 N 次被调用时写入 msg-N.txt（fixup/drop 不触发编辑器）。
    let editor_path = dir.join("editor.sh");
    let script = format!(
        "#!/bin/sh\nd=\"{d}\"\nn=$(cat \"$d/.n\" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > \"$d/.n\"\necho \"invoked #$n for $1\" >> \"$d/invocations\"\nif [ -f \"$d/msg-$n.txt\" ]; then cp \"$d/msg-$n.txt\" \"$1\"; fi\nexit 0\n",
        d = dir.display()
    );
    std::fs::write(&editor_path, script)
        .map_err(|e| AppError::Io(format!("写入变基编辑器脚本失败: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&editor_path)
            .map_err(|e| AppError::Io(format!("读取编辑器脚本元数据失败: {e}")))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&editor_path, perms)
            .map_err(|e| AppError::Io(format!("设置编辑器脚本权限失败: {e}")))?;
    }
    for (idx, msg) in editor_messages.iter().enumerate() {
        std::fs::write(dir.join(format!("msg-{}.txt", idx + 1)), format!("{msg}\n"))
            .map_err(|e| AppError::Io(format!("写入变基说明文件失败: {e}")))?;
    }

    // 基准：段内最旧提交的父提交；无父（根提交参与）→ --root。
    let oldest = chain[0];
    let oldest_commit = repo
        .find_commit(oldest)
        .map_err(|e| AppError::Git(format!("读取段内最旧提交失败: {e}")))?;
    let mut args: Vec<&str> = vec!["rebase", "-i", "--empty=keep"];
    let base_str;
    if oldest_commit.parent_count() == 0 {
        args.push("--root");
    } else {
        let base = oldest_commit
            .parent_id(0)
            .map_err(|e| AppError::Git(format!("读取基准父提交失败: {e}")))?;
        base_str = base.to_string();
        args.push(base_str.as_str());
    }

    let seq_editor = format!("cp '{}'", todo_path.display());
    let editor_str = editor_path.display().to_string();
    let envs: Vec<(&str, &str)> = vec![
        ("GIT_SEQUENCE_EDITOR", seq_editor.as_str()),
        ("GIT_EDITOR", editor_str.as_str()),
    ];

    let child = spawn_git_command_with_envs(workdir, &args, false, &envs)?;
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Io(format!("等待 git 子进程失败: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if output.status.success() {
        cleanup_rebase_editor(repo);
        let summary = normalize_output(&stdout, &stderr);
        return action_result(
            repo,
            format!(
                "{summary}\n原 HEAD {old} 已备份于 {REBASE_BACKUP_REF}",
                old = &head_oid.to_string()[..7],
            ),
        );
    }

    // 冲突暂停：仓库处于变基中 → 返回 Ok，前端复用冲突编辑器与继续 / 中止。
    if git_service::repo_state(repo) == crate::types::RepoState::Rebasing {
        return action_result(
            repo,
            format!(
                "变基暂停：存在未解决的冲突，请在冲突编辑器中解决并暂存后点击「继续」完成变基（或「中止」恢复；原历史备份于 {REBASE_BACKUP_REF}）\n{}",
                normalize_output(&stdout, &stderr)
            ),
        );
    }

    // 未进入变基状态的真实失败：清理持久编辑器目录。
    cleanup_rebase_editor(repo);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Err(AppError::Git(format!(
        "git {} 失败:\n{detail}",
        args.join(" ")
    )))
}

/// 从指定提交恢复单个文件到工作区并暂存（`git checkout <commit> -- <path>`，
/// v0.7 / 7.7）。commit id 与路径均先行校验，防止参数注入。
pub fn checkout_file_from(
    repo: &git2::Repository,
    workdir: &Path,
    commit_id: &str,
    path: &str,
) -> AppResult<GitActionResult> {
    let commit = crate::git_service::find_commit(repo, commit_id)?;
    crate::git_service::validate_rel_path(path)?;
    // 该提交删除了此文件（树中无此路径）→ 回退到第一父提交检出
    // （review 修复 #6：用户意图是"把文件从删除前的版本拿回来"）。
    let target = if commit
        .tree()
        .ok()
        .and_then(|t| t.get_path(std::path::Path::new(path)).ok())
        .is_some()
    {
        commit
    } else if commit.parent_count() > 0 {
        commit
            .parent(0)
            .map_err(|e| AppError::Git(format!("读取父提交失败: {e}")))?
    } else {
        return Err(AppError::NotFound(format!(
            "提交中不存在文件 {path}，且没有可回退的父提交"
        )));
    };
    let oid = target.id().to_string();
    let output = run_git(workdir, &["checkout", &oid, "--", path])?;
    action_result(repo, output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RebaseAction, RebasePlanEntry};
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
        let res =
            create_branch(&fx.work, &dir, "topic/ui", None, true).expect("create_branch 失败");
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
        assert_eq!(
            std::fs::read_to_string(dir.join("topic.txt")).unwrap(),
            "v1\n"
        );

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

    #[test]
    fn discard_file_preserves_staged_changes_and_staged_deletions() {
        let fx = setup_with_bare_remote();
        let dir = fx.work.workdir().unwrap().to_path_buf();

        // 先在 HEAD 提交 tracked.txt，再暂存 v2 并继续修改工作区为 v3；
        // discard_file 必须从 index 恢复 v2，不得执行 checkout HEAD 回退暂存区到 v1。
        std::fs::write(dir.join("tracked.txt"), "v1-head\n").unwrap();
        run_git(&dir, &["add", "tracked.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "add tracked"]).unwrap();

        std::fs::write(dir.join("tracked.txt"), "v2-staged\n").unwrap();
        run_git(&dir, &["add", "tracked.txt"]).unwrap();
        std::fs::write(dir.join("tracked.txt"), "v3-workdir\n").unwrap();

        discard_file(&fx.work, &dir, "tracked.txt").expect("discard_file 失败");
        assert_eq!(
            std::fs::read_to_string(dir.join("tracked.txt")).unwrap(),
            "v2-staged\n",
            "工作区应从 index 恢复而不丢弃已暂存更改"
        );
        let idx = git_service::fresh_index(&fx.work).unwrap();
        let entry = idx.get_path(Path::new("tracked.txt"), 0).unwrap();
        let blob = fx.work.find_blob(entry.id).unwrap();
        assert_eq!(blob.content(), b"v2-staged\n");

        // 已暂存删除后，工作区又出现同名未跟踪文件：discard_file 应删除该文件且保留暂存删除
        run_git(&dir, &["rm", "-f", "tracked.txt"]).unwrap();
        std::fs::write(dir.join("tracked.txt"), "new-untracked\n").unwrap();
        discard_file(&fx.work, &dir, "tracked.txt").expect("discard untracked after rm 失败");
        assert!(!dir.join("tracked.txt").exists());
        let idx2 = git_service::fresh_index(&fx.work).unwrap();
        assert!(idx2.get_path(Path::new("tracked.txt"), 0).is_none());
    }

    #[test]
    fn parse_progress_percent_extracts_percentages() {
        assert_eq!(
            parse_progress_percent("Receiving objects:  45% (9/20)"),
            Some(45)
        );
        assert_eq!(
            parse_progress_percent("Resolving deltas: 100% (12/12), done."),
            Some(100)
        );
        assert_eq!(
            parse_progress_percent("Enumerating objects: 10, done."),
            None
        );
        assert_eq!(parse_progress_percent("weird 150%"), None);
    }

    #[test]
    fn conflict_abort_and_continue_for_merge_cherry_pick_and_rebase() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        let base_oid = commit_file(&repo, "a.txt", "base\n", "base");
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();

        // 创建 topic 分支并制造冲突提交
        let base_commit = repo
            .find_commit(git2::Oid::from_str(&base_oid).unwrap())
            .unwrap();
        repo.branch("topic", &base_commit, false).unwrap();
        drop(base_commit);
        run_git(dir.path(), &["checkout", "topic"]).unwrap();
        let topic_oid = commit_file(&repo, "a.txt", "topic\n", "topic edit");

        run_git(dir.path(), &["checkout", &branch]).unwrap();
        let main_oid = commit_file(&repo, "a.txt", "main\n", "main edit");

        // 1. merge 冲突 → abort_operation 恢复 Clean
        assert!(merge_branch(&repo, dir.path(), "topic").is_err());
        assert_eq!(git_service::repo_state(&repo), RepoState::Merging);
        let aborted = abort_operation(&repo, dir.path()).expect("merge abort 失败");
        assert_eq!(aborted.repo.state, RepoState::Clean);
        assert_eq!(aborted.repo.head_commit, main_oid);

        // 2. merge 冲突 → 解决 + 暂存 → continue_operation 完成双亲合并
        assert!(merge_branch(&repo, dir.path(), "topic").is_err());
        assert!(
            continue_operation(&repo, dir.path()).is_err(),
            "未解决冲突不得 continue"
        );
        std::fs::write(dir.path().join("a.txt"), "merged\n").unwrap();
        run_git(dir.path(), &["add", "a.txt"]).unwrap();
        let continued = continue_operation(&repo, dir.path()).expect("merge continue 失败");
        assert_eq!(continued.repo.state, RepoState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);

        // 重置回 main_oid 再测 cherry-pick
        reset_head(&repo, dir.path(), &main_oid, "hard").unwrap();
        assert!(cherry_pick_commit(&repo, dir.path(), &topic_oid).is_err());
        assert_eq!(git_service::repo_state(&repo), RepoState::CherryPicking);
        abort_operation(&repo, dir.path()).expect("cherry-pick abort 失败");
        assert_eq!(git_service::repo_state(&repo), RepoState::Clean);

        assert!(cherry_pick_commit(&repo, dir.path(), &topic_oid).is_err());
        std::fs::write(dir.path().join("a.txt"), "picked\n").unwrap();
        run_git(dir.path(), &["add", "a.txt"]).unwrap();
        let cp_ok = continue_operation(&repo, dir.path()).expect("cherry-pick continue 失败");
        assert_eq!(cp_ok.repo.state, RepoState::Clean);

        // 重置到 topic 分支并 rebase 到 main 上产生冲突 → 解决并 continue
        run_git(dir.path(), &["checkout", "topic"]).unwrap();
        let rebase_res = run_git(dir.path(), &["rebase", &branch]);
        assert!(rebase_res.is_err());
        assert_eq!(git_service::repo_state(&repo), RepoState::Rebasing);
        std::fs::write(dir.path().join("a.txt"), "rebased\n").unwrap();
        run_git(dir.path(), &["add", "a.txt"]).unwrap();
        let rb_ok = continue_operation(&repo, dir.path()).expect("rebase continue 失败");
        assert_eq!(rb_ok.repo.state, RepoState::Clean);
    }

    #[test]
    fn remote_op_manager_cancels_running_process() {
        let dir = tempfile::tempdir().unwrap();
        let manager = RemoteOpManager::new();
        let mut cmd = Command::new("sleep");
        cmd.arg("10").current_dir(dir.path());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = cmd.spawn().expect("spawn sleep");
        let (_id, cancelled, child_arc) = manager.register("repo-1", child);
        assert!(manager.cancel("repo-1"));
        assert!(cancelled.load(Ordering::SeqCst));
        if let Some(mut c) = child_arc.lock().unwrap().take() {
            let _ = c.wait();
        }
        assert!(!manager.cancel("missing-repo"));
    }

    #[test]
    fn stash_branch_creates_checks_out_and_pops() {
        let fx = setup_with_bare_remote();
        let dir = fx.workdir();
        commit_file(&fx.work, "base.txt", "v1\n", "base commit");

        // 贮藏一个修改 + 未跟踪文件
        std::fs::write(dir.join("base.txt"), "v1\ndirty\n").unwrap();
        std::fs::write(dir.join("new.txt"), "staged-in-stash\n").unwrap();
        stash_push(&fx.work, &dir, Some("wip feature")).expect("stash_push 失败");
        assert_eq!(
            std::fs::read_to_string(dir.join("base.txt")).unwrap(),
            "v1\n"
        );

        // 从贮藏建分支：检出基准提交、应用贮藏、成功后弹出
        let res = stash_branch(&fx.work, &dir, "feature/from-stash", 0).expect("stash_branch 失败");
        assert_eq!(res.repo.head_branch.as_deref(), Some("feature/from-stash"));
        assert!(dir.join("new.txt").exists());
        assert!(
            std::fs::read_to_string(dir.join("base.txt"))
                .unwrap()
                .contains("dirty")
        );
        assert!(list_stashes(&dir).unwrap().is_empty());

        // 非法分支名被拒绝
        assert!(stash_branch(&fx.work, &dir, "bad name", 0).is_err());
    }
    #[test]
    fn interactive_rebase_reorders_and_drops_with_backup() {
        let mut fx = setup_with_bare_remote();
        let dir = fx.workdir();
        // 三条线性提交：c1 → c2 → c3
        commit_file(&fx.work, "a.txt", "one\n", "feat: one");
        commit_file(&fx.work, "b.txt", "two\n", "feat: two");
        let c3 = commit_file(&fx.work, "c.txt", "three\n", "feat: three");
        // 收集 c1/c2 的 id（HEAD~1 / HEAD~2）
        let (c1, c2) = {
            let head = fx.work.head().unwrap().peel_to_commit().unwrap();
            (
                head.parent(0).unwrap().parent(0).unwrap().id().to_string(),
                head.parent(0).unwrap().id().to_string(),
            )
        };

        // 计划：drop c2，重排为 c3 在前、c1 在后
        let plan = vec![
            RebasePlanEntry {
                commit_id: c3.clone(),
                action: RebaseAction::Pick,
                message: None,
            },
            RebasePlanEntry {
                commit_id: c2,
                action: RebaseAction::Drop,
                message: None,
            },
            RebasePlanEntry {
                commit_id: c1,
                action: RebaseAction::Pick,
                message: None,
            },
        ];
        let res = interactive_rebase(&mut fx.work, &dir, &plan).expect("interactive_rebase 失败");
        assert_eq!(res.repo.state, RepoState::Clean);

        // 新历史：one → three（c2 被丢弃，c3 被重排到 c1 之后）
        let new_head = fx.work.head().unwrap().peel_to_commit().unwrap();
        let subjects: Vec<String> = {
            let mut v = vec![new_head.message().unwrap().trim().to_string()];
            let mut cur = new_head.clone();
            while cur.parent_count() == 1 {
                cur = cur.parent(0).unwrap();
                v.push(cur.message().unwrap().trim().to_string());
            }
            v.reverse();
            v
        };
        // fixture 的 initial 提交之后：按新顺序 three → one（two 被丢弃）
        assert_eq!(subjects, vec!["initial", "feat: three", "feat: one"]);
        // 备份引用指向原 HEAD
        let backup = fx.work.find_reference(REBASE_BACKUP_REF).unwrap();
        assert_eq!(backup.target().unwrap().to_string(), c3);
        // 工作区内容：a.txt 与 c.txt 存在，b.txt 因 drop 且重排后基于 c1 → 不存在
        assert!(dir.join("a.txt").exists());
        assert!(dir.join("c.txt").exists());
        assert!(!dir.join("b.txt").exists());
    }

    #[test]
    fn interactive_rebase_reword_and_squash_custom_messages() {
        let mut fx = setup_with_bare_remote();
        let dir = fx.workdir();
        commit_file(&fx.work, "a.txt", "one\n", "feat: base");
        commit_file(&fx.work, "a.txt", "one\ntwo\n", "wip: two");
        let (c1, c2) = {
            let head = fx.work.head().unwrap().peel_to_commit().unwrap();
            (
                head.parent(0).unwrap().id().to_string(),
                head.id().to_string(),
            )
        };

        // reword 第一条 + squash 第二条（自定义合并文案）
        let plan = vec![
            RebasePlanEntry {
                commit_id: c1,
                action: RebaseAction::Reword,
                message: Some("feat: base (reworded)".to_string()),
            },
            RebasePlanEntry {
                commit_id: c2,
                action: RebaseAction::Squash,
                message: Some("squashed: two changes".to_string()),
            },
        ];
        let res = interactive_rebase(&mut fx.work, &dir, &plan).expect("interactive_rebase 失败");
        assert_eq!(res.repo.state, RepoState::Clean);
        let new_head = fx.work.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(new_head.parent_count(), 1); // squash 后仍单条新提交（含父）
        assert_eq!(new_head.message().unwrap().trim(), "squashed: two changes");
        // 内容为两边叠加
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn interactive_rebase_conflict_continue_and_abort_keep_backup() {
        let mut fx = setup_with_bare_remote();
        let dir = fx.workdir();
        // 两条提交都修改同一行 → 任意重排都会冲突
        commit_file(&fx.work, "a.txt", "line v1\n", "change one");
        commit_file(&fx.work, "a.txt", "line v2\n", "change two");
        let (c1, c2, original_head) = {
            let head = fx.work.head().unwrap().peel_to_commit().unwrap();
            (
                head.parent(0).unwrap().id().to_string(),
                head.id().to_string(),
                head.id().to_string(),
            )
        };

        // 重排（two 在前，one 在后）→ 第二条 pick 必然冲突；
        // 首条带 Reword：验证冲突暂停后自定义说明仍被写入（review 修复 #2）。
        let plan = vec![
            RebasePlanEntry {
                commit_id: c2,
                action: RebaseAction::Reword,
                message: Some("change two (reworded)".to_string()),
            },
            RebasePlanEntry {
                commit_id: c1,
                action: RebaseAction::Pick,
                message: None,
            },
        ];
        let res = interactive_rebase(&mut fx.work, &dir, &plan).expect("冲突应返回 Ok 而非 Err");
        assert_eq!(res.repo.state, RepoState::Rebasing);

        // —— 走通 Continue：重排两条互改同一行的提交会连续产生冲突，
        // 循环「解决 → 暂存 → rebase --continue」直至变基完成 ——
        let mut rounds = 0;
        loop {
            if crate::git_service::repo_state(&fx.work) == RepoState::Clean {
                break;
            }
            // 每轮写入不同内容，避免后续步骤变成空提交被 --empty 丢弃。
            let resolved = if rounds % 2 == 0 {
                "line merged\n"
            } else {
                "line merged final\n"
            };
            std::fs::write(dir.join("a.txt"), resolved).unwrap();
            crate::git_service::stage_file(&mut fx.work, "a.txt").expect("暂存解决内容失败");
            // 多轮冲突下 continue 返回 Ok 且状态可能仍为 Rebasing（下一轮冲突）。
            let _step = continue_operation(&fx.work, &dir).expect("rebase --continue 失败");
            rounds += 1;
            assert!(rounds < 5, "冲突轮次异常");
        }
        assert_eq!(crate::git_service::repo_state(&fx.work), RepoState::Clean);
        assert!(rounds >= 1, "重排互改提交至少应有一轮冲突");
        // Reword 的自定义说明在多轮冲突后仍应生效（位于 HEAD~1）。
        {
            let final_head = fx.work.head().unwrap().peel_to_commit().unwrap();
            assert_eq!(final_head.message().unwrap().trim(), "change one");
            let second = final_head.parent(0).unwrap();
            assert_eq!(second.message().unwrap().trim(), "change two (reworded)");
        }
        // 持久编辑器目录在完成后被清理。
        assert!(!fx.work.path().join("opl-rebase-editor").exists());
        // 备份引用仍指向原 HEAD（不丢失提交）
        assert_eq!(
            fx.work
                .find_reference(REBASE_BACKUP_REF)
                .unwrap()
                .target()
                .unwrap()
                .to_string(),
            original_head
        );

        // —— Abort 场景：再次触发冲突后中止，完全恢复 ——
        let post_continue_head = {
            let h = fx.work.head().unwrap().peel_to_commit().unwrap();
            h.id().to_string()
        };
        commit_file(&fx.work, "a.txt", "line v3\n", "change three");
        let c3 = fx
            .work
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string();
        // 重排（three 在前）→ 与继续后的提交（同改 a.txt）冲突
        let plan2 = vec![
            RebasePlanEntry {
                commit_id: c3.clone(),
                action: RebaseAction::Pick,
                message: None,
            },
            RebasePlanEntry {
                commit_id: post_continue_head,
                action: RebaseAction::Pick,
                message: None,
            },
        ];
        let res2 = interactive_rebase(&mut fx.work, &dir, &plan2).expect("第二次冲突应返回 Ok");
        assert_eq!(res2.repo.state, RepoState::Rebasing);
        let aborted = abort_operation(&fx.work, &dir).expect("rebase --abort 失败");
        assert_eq!(aborted.repo.state, RepoState::Clean);
        // 中止后应清理持久编辑器目录，避免残留脚本被后续「继续」误用。
        assert!(
            !fx.work.path().join("opl-rebase-editor").exists(),
            "中止后 opl-rebase-editor 应被清理"
        );
        assert_eq!(
            fx.work
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id()
                .to_string(),
            c3
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "line v3\n"
        );
    }

    /// v0.7 / 7.7：从指定提交恢复单个文件（工作区 + 暂存区）。
    #[test]
    fn checkout_file_from_restores_content_and_stages() {
        let fx = setup_with_bare_remote();
        let dir = fx.workdir();
        commit_file(&fx.work, "a.txt", "v1\n", "initial");
        let old = commit_file(&fx.work, "a.txt", "v1\nv2\n", "add v2");
        // 再改一次并提交，使 HEAD 版本与 old 不同
        commit_file(&fx.work, "a.txt", "v1\nv2\nv3\n", "add v3");

        let res = checkout_file_from(&fx.work, &dir, &old, "a.txt").expect("恢复失败");
        assert_eq!(res.repo.state, RepoState::Clean);
        // 工作区恢复到 old 版本
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "v1\nv2\n"
        );
        // 已直接进入暂存区（git checkout <commit> -- path 的语义）
        let statuses = git_service::status(&fx.work).unwrap();
        let entry = statuses.iter().find(|s| s.path == "a.txt").unwrap();
        assert_eq!(entry.staged, Some(crate::types::ChangeType::Modified));
        assert_eq!(entry.unstaged, None);

        // 越界路径拒绝
        assert!(checkout_file_from(&fx.work, &dir, &old, "../escape.txt").is_err());
    }
    #[test]
    fn checkout_file_from_deleted_commit_restores_from_parent() {
        let fx = setup_with_bare_remote();
        let dir = fx.workdir();
        commit_file(&fx.work, "a.txt", "v1\n", "create a");
        let del = commit_file(&fx.work, "b.txt", "temp\n", "add b then delete");
        // 删除 a.txt 的提交
        std::fs::remove_file(dir.join("a.txt")).unwrap();
        {
            let mut index = fx.work.index().unwrap();
            index.remove_path(std::path::Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree = fx
                .work
                .find_tree(index.write_tree_to(&fx.work).unwrap())
                .unwrap();
            let head = fx.work.head().unwrap().peel_to_commit().unwrap();
            fx.work
                .commit(
                    Some("HEAD"),
                    &sig(),
                    &sig(),
                    "delete a.txt",
                    &tree,
                    &[&head],
                )
                .unwrap();
        }
        let del_id = fx
            .work
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string();
        let _ = del;

        // 在删除提交上恢复 a.txt：应回退到父提交检出，文件失而复得
        checkout_file_from(&fx.work, &dir, &del_id, "a.txt").expect("恢复已删除文件失败");
        assert!(dir.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1\n");
    }
}
