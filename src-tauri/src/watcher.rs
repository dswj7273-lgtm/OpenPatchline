//! 仓库变更监听（docs/04 §7）：`notify` 监听已打开仓库的 `.git` 目录，
//! 防抖后经 Tauri 事件 `repo_status_changed` 推送 repo_id，前端收到后
//! 自动刷新——IDEA 式的「外部提交 / 分支切换立即呈现，无需手动刷新」。
//!
//! 约定：
//! - 每个已打开仓库一个递归 watcher + 一个防抖线程：git 单次操作会产生
//!   事件风暴（index、多个 refs、锁文件），静默 [`DEBOUNCE`] 后合并为
//!   一次通知；
//! - 只关心表征状态变化的路径（refs/、index、HEAD、MERGE_HEAD 等）；
//!   `objects/` 写入与 `*.lock` 生命周期不触发通知；
//! - 通知失败（前端已卸载监听等）静默忽略——刷新是尽力而为的增强。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::Watcher;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

/// 推送给前端的 Tauri 事件名（负载为 repo_id）。
pub const REPO_STATUS_CHANGED_EVENT: &str = "repo_status_changed";

/// 防抖静默期：最后一次 .git 变更后等待多久再通知。
const DEBOUNCE: Duration = Duration::from_millis(500);

/// `.git` 内部路径是否表征仓库状态变化（值得触发刷新）。
///
/// 只监听 refs/、index、HEAD、packed-refs、MERGE_HEAD / FETCH_HEAD /
/// CHERRY_PICK_HEAD / REVERT_HEAD / REBASE_HEAD / rebase-*；
/// 排除 objects/ 写入与 `*.lock` 锁文件（fetch/commit 期间的高频噪音）。
fn is_relevant(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.ends_with(".lock") {
        return false;
    }
    if normalized.contains("/objects/") {
        return false;
    }
    normalized.contains("/refs/")
        || normalized.ends_with("/HEAD")
        || normalized.ends_with("/index")
        || normalized.ends_with("/packed-refs")
        || normalized.ends_with("/MERGE_HEAD")
        || normalized.ends_with("/FETCH_HEAD")
        || normalized.ends_with("/CHERRY_PICK_HEAD")
        || normalized.ends_with("/REVERT_HEAD")
        || normalized.ends_with("/REBASE_HEAD")
        || normalized.contains("/rebase-merge")
        || normalized.contains("/rebase-apply")
}

/// 防抖循环：收到首个消息后持续吸收，静默 [`DEBOUNCE`] 无新消息时把
/// 累积的 repo_id 集合逐个回调（一次 git 操作风暴 → 一轮通知）。
///
/// 与 [`RepoWatcher`] 解耦（回调注入），便于单元测试。
fn debounce_loop(rx: mpsc::Receiver<String>, mut notify: impl FnMut(String)) {
    while let Ok(first) = rx.recv() {
        let mut pending = HashSet::new();
        pending.insert(first);
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(id) => {
                    pending.insert(id);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                // 发送端（watcher）已销毁：把已积累的发出后结束线程。
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    for id in pending {
                        notify(id);
                    }
                    return;
                }
            }
        }
        for id in pending {
            notify(id);
        }
    }
}

/// 已打开仓库的监听表：repo_id → notify watcher。
///
/// 防抖线程持有 Tauri [`AppHandle`] 直接 emit；重复 watch 同一仓库时
/// 替换旧 watcher（旧的 Drop → 通道断开 → 防抖线程自然退出）。
#[derive(Clone)]
pub struct RepoWatcher {
    app: AppHandle,
    watchers: Arc<Mutex<HashMap<String, notify::RecommendedWatcher>>>,
}

impl RepoWatcher {
    /// 创建监听表（在 Tauri setup 阶段 manage）。
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 监听 `gitdir`（仓库 `.git` 目录），变更经防抖后 emit
    /// [`REPO_STATUS_CHANGED_EVENT`]；幂等（重复调用替换旧 watcher）。
    pub fn watch(&self, repo_id: &str, gitdir: &Path) -> AppResult<()> {
        let (tx, rx) = mpsc::channel::<String>();
        let id_for_cb = repo_id.to_string();
        let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            if let Ok(event) = res
                && event.paths.iter().any(|p| is_relevant(p))
            {
                let _ = tx.send(id_for_cb.clone());
            }
        })
        .map_err(|e| AppError::Io(format!("创建文件监听失败: {e}")))?;
        watcher
            .watch(gitdir, notify::RecursiveMode::Recursive)
            .map_err(|e| AppError::Io(format!("监听 {} 失败: {e}", gitdir.display())))?;

        // 防抖线程：向所有窗口 emit 事件（忽略 emit 失败）。
        let app = self.app.clone();
        std::thread::spawn(move || {
            debounce_loop(rx, |id| {
                let _ = app.emit(REPO_STATUS_CHANGED_EVENT, id);
            });
        });

        self.watchers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(repo_id.to_string(), watcher);
        Ok(())
    }

    /// 停止监听并移除条目（v0.8 / 8.4 仓库淘汰时释放 notify 句柄与防抖线程）。
    pub fn unwatch(&self, repo_id: &str) {
        self.watchers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(repo_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 路径过滤：refs / index / HEAD 触发；objects / 锁文件不触发。
    #[test]
    fn relevant_paths() {
        assert!(is_relevant(Path::new("/repo/.git/refs/heads/main")));
        assert!(is_relevant(Path::new("/repo/.git/HEAD")));
        assert!(is_relevant(Path::new("/repo/.git/index")));
        assert!(is_relevant(Path::new("/repo/.git/packed-refs")));
        assert!(is_relevant(Path::new("/repo/.git/MERGE_HEAD")));
        assert!(is_relevant(Path::new("/repo/.git/CHERRY_PICK_HEAD")));
        assert!(is_relevant(Path::new("/repo/.git/REVERT_HEAD")));
        assert!(is_relevant(Path::new("/repo/.git/REBASE_HEAD")));
        assert!(is_relevant(Path::new("/repo/.git/rebase-merge/msgnum")));
        assert!(!is_relevant(Path::new("/repo/.git/objects/ab/cdef")));
        assert!(!is_relevant(Path::new("/repo/.git/index.lock")));
        assert!(!is_relevant(Path::new("/repo/.git/refs/heads/main.lock")));
        // Windows 反斜杠路径同样兼容。
        assert!(is_relevant(Path::new(r"C:\repo\.git\refs\heads\main")));
        assert!(is_relevant(Path::new(r"C:\repo\.git\HEAD")));
        assert!(is_relevant(Path::new(r"C:\repo\.git\index")));
        assert!(is_relevant(Path::new(r"C:\repo\.git\CHERRY_PICK_HEAD")));
        assert!(!is_relevant(Path::new(r"C:\repo\.git\objects\ab\cdef")));
        assert!(!is_relevant(Path::new(r"C:\repo\.git\index.lock")));
    }

    /// 防抖：一次风暴内的多条消息合并为一轮通知；两个 repo_id 都送达。
    #[test]
    fn debounce_collapses_burst_into_one_round() {
        let (tx, rx) = mpsc::channel();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        std::thread::spawn(move || debounce_loop(rx, move |id| sink.lock().unwrap().push(id)));

        // 同一风暴：a 的多条 + b 的一条。
        for id in ["a", "a", "b"] {
            tx.send(id.to_string()).expect("send 失败");
        }
        drop(tx); // 结束后断开，触发 Disconnected 分支的冲刷。

        // 防抖窗口 + 线程调度余量。
        std::thread::sleep(DEBOUNCE + Duration::from_millis(300));
        let mut got = seen.lock().unwrap().clone();
        got.sort();
        assert_eq!(
            got,
            vec!["a".to_string(), "b".to_string()],
            "风暴合并为单轮通知，重复 id 去重"
        );
    }
}
