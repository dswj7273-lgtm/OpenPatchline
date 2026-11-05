//! Repository Manager（docs/03 §2.2）：维护已打开仓库表。
//!
//! - `repo_id` = workdir 根路径 canonicalize 后的绝对路径；
//! - 每个仓库一个 [`RepoEntry`]（git2 仓库句柄 + 该仓库专属的图布局增量状态）；
//!   `git2::Repository` 是 `Send` 但不是 `Sync`，因此条目各自包一层 `Mutex`，
//!   命令层按次加锁借用（写操作需要 `&mut`）；
//! - [`RepoManager`] 内部是共享句柄（`Arc`），克隆廉价且可整体移入
//!   `spawn_blocking`，供 async 命令在后台线程访问同一张表。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::git_service;
use crate::graph;
use crate::types::RepoInfo;

/// 单个已打开仓库的条目。
pub struct RepoEntry {
    /// git2 仓库句柄（stage/unstage/commit 等写操作需要 `&mut`）。
    pub repo: git2::Repository,
    /// 该仓库的泳道布局增量状态（跨分页持久，见 graph 模块）。
    pub graph_state: graph::GraphState,
}

/// 已打开仓库表：`repo_id` → 条目共享句柄。
///
/// 外层 `Mutex` 只保护表结构（增删查），条目本身的互斥由各自的
/// `Mutex` 承担，避免不同仓库的命令互相阻塞。
/// `Clone` 后共享同一张表。
#[derive(Clone, Default)]
pub struct RepoManager {
    repos: Arc<Mutex<HashMap<String, Arc<Mutex<RepoEntry>>>>>,
}

impl RepoManager {
    /// 创建空表。
    pub fn new() -> Self {
        Self::default()
    }

    /// 打开（或复用）`path` 处的仓库。
    ///
    /// 1. `std::fs::canonicalize` 解析为绝对路径；
    /// 2. `git2::Repository::open_ext`（允许向上搜索父目录）：选中仓库内
    ///    任意子目录时定位到仓库根（与 IntelliJ 行为一致）；
    /// 3. `repo_id` 一律取**仓库根**（workdir）的 canonicalize 路径——
    ///    从不同子目录打开同一仓库会命中同一条目；
    /// 4. 已打开的仓库直接复用既有条目（保留图状态等增量缓存）。
    ///
    /// 找不到仓库时返回 [`AppError::NotFound`]（区别于其他 Git 错误，
    /// 命令层据此触发子仓库扫描）。
    pub fn open(&self, path: &Path) -> AppResult<RepoInfo> {
        let canonical: PathBuf = std::fs::canonicalize(path).map_err(|e| {
            AppError::Io(format!("路径 {} 不存在或无法解析: {e}", path.display()))
        })?;

        // 空 flags = 允许向上搜索父目录（libgit2 默认 open 带 NO_SEARCH）。
        let repo = match git2::Repository::open_ext(
            &canonical,
            git2::RepositoryOpenFlags::empty(),
            &[] as &[&std::ffi::OsStr],
        ) {
            Ok(repo) => repo,
            Err(e) if e.code() == git2::ErrorCode::NotFound => {
                return Err(AppError::NotFound(format!(
                    "{} 不是 Git 仓库",
                    canonical.display()
                )))
            }
            Err(e) => {
                return Err(AppError::Git(format!(
                    "打开仓库 {} 失败: {e}",
                    canonical.display()
                )))
            }
        };

        // 仓库根：向上搜索可能命中父目录里的仓库，id 必须取根而非输入路径。
        let root = repo
            .workdir()
            .ok_or_else(|| AppError::InvalidArg("bare 仓库没有工作区".to_string()))?
            .to_path_buf();
        let root = std::fs::canonicalize(&root).map_err(|e| {
            AppError::Io(format!("解析仓库根路径 {} 失败: {e}", root.display()))
        })?;
        let id = root.to_string_lossy().into_owned();

        // 快路径：已打开则复用既有条目（并发 open 同一仓库时以后写入者为准）。
        if let Some(entry) = self.lock_table().get(&id).cloned() {
            let entry = lock_entry(&entry);
            return git_service::repo_info(&entry.repo);
        }

        let entry = RepoEntry {
            repo,
            graph_state: graph::GraphState::new(),
        };
        let info = git_service::repo_info(&entry.repo)?;
        self.lock_table()
            .insert(id, Arc::new(Mutex::new(entry)));
        Ok(info)
    }

    /// 按 `repo_id` 取条目共享句柄；未知 id → [`AppError::NotFound`]。
    pub fn entry(&self, repo_id: &str) -> AppResult<Arc<Mutex<RepoEntry>>> {
        self.lock_table()
            .get(repo_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("仓库未打开: {repo_id}")))
    }

    /// 锁定仓库表（中毒时恢复，见 [`lock_entry`] 的说明）。
    fn lock_table(&self) -> MutexGuard<'_, HashMap<String, Arc<Mutex<RepoEntry>>>> {
        self.repos.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// 锁定单个仓库条目。
///
/// Mutex 中毒（持锁线程 panic）时恢复继续：git 操作要么只读、要么幂等，
/// 不应让一次 panic 永久锁死该仓库的全部后续操作。
pub fn lock_entry(entry: &Arc<Mutex<RepoEntry>>) -> MutexGuard<'_, RepoEntry> {
    entry.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 初始化临时仓库（无提交；与 git_service 测试同一套路）。
    fn init_repo() -> (tempfile::TempDir, git2::Repository) {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let repo = git2::Repository::init(dir.path()).expect("初始化仓库失败");
        (dir, repo)
    }

    /// open 登记条目并返回 canonicalize 后的 id；entry 可再借出同一仓库。
    #[test]
    fn open_registers_entry_and_returns_info() {
        let (dir, _repo) = init_repo();
        let manager = RepoManager::new();

        let info = manager.open(dir.path()).expect("打开仓库失败");
        assert_eq!(info.id, dir.path().canonicalize().expect("canonicalize").to_string_lossy());
        assert_eq!(info.head_commit, "", "空仓库 head_commit 为空字符串");

        // 借出的条目可正常执行 git 操作。
        let entry = manager.entry(&info.id).expect("按 id 取条目失败");
        let entry = lock_entry(&entry);
        let statuses = git_service::status(&entry.repo).expect("读取状态失败");
        assert!(statuses.is_empty(), "空仓库工作区应无变更");
    }

    /// 未知 repo_id → NotFound。
    #[test]
    fn entry_unknown_id_returns_not_found() {
        let manager = RepoManager::new();
        match manager.entry("/no/such/repo") {
            Err(AppError::NotFound(_)) => {}
            Err(e) => panic!("期望 NotFound，实际 {e:?}"),
            Ok(_) => panic!("未知 repo_id 不应取到条目"),
        }
    }

    /// 重复 open 同一路径复用既有条目（Arc 同一），并刷新 RepoInfo。
    #[test]
    fn reopen_same_path_reuses_entry() {
        let (dir, _repo) = init_repo();
        let manager = RepoManager::new();
        let first = manager.open(dir.path()).expect("首次打开失败");
        let second = manager.open(dir.path()).expect("再次打开失败");
        assert_eq!(first.id, second.id);

        let a = manager.entry(&first.id).expect("取条目 a 失败");
        let b = manager.entry(&second.id).expect("取条目 b 失败");
        assert!(Arc::ptr_eq(&a, &b), "同一路径应复用同一仓库条目");
    }

    /// 非 git 目录 open 失败（NotFound），且不登记条目。
    #[test]
    fn open_non_git_dir_fails() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let manager = RepoManager::new();
        match manager.open(dir.path()) {
            Err(AppError::NotFound(_)) => {}
            Err(e) => panic!("期望 NotFound，实际 {e:?}"),
            Ok(_) => panic!("非 git 目录不应打开成功"),
        }
        assert!(manager.entry(dir.path().to_string_lossy().as_ref()).is_err());
    }

    /// 选中仓库内子目录时向上搜索定位仓库根，且与直接打开根目录复用同一条目。
    #[test]
    fn open_subdirectory_finds_repo_root() {
        let (dir, _repo) = init_repo();
        let sub = dir.path().join("nested/deep");
        std::fs::create_dir_all(&sub).expect("创建子目录失败");
        let manager = RepoManager::new();

        let via_sub = manager.open(&sub).expect("从子目录打开失败");
        let via_root = manager.open(dir.path()).expect("从根目录打开失败");
        assert_eq!(via_sub.id, via_root.id, "子目录与根目录应解析到同一仓库 id");

        let a = manager.entry(&via_sub.id).expect("取条目 a 失败");
        let b = manager.entry(&via_root.id).expect("取条目 b 失败");
        assert!(Arc::ptr_eq(&a, &b), "应复用同一仓库条目");
    }
}
