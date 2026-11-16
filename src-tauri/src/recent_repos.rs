//! 最近打开仓库列表持久化（存放在 Tauri app_data_dir 下 `recent_repos.json`）。
//!
//! 读写与清理逻辑均接受显式文件路径，便于单元测试用 `tempfile` 隔离验证。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::types::{RecentRepo, RepoInfo};

/// 最近仓库保留上限。
const MAX_RECENT_REPOS: usize = 15;
const RECENT_FILE_NAME: &str = "recent_repos.json";

/// 返回当前 Unix 时间戳（秒）。
pub fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 解析应用数据目录下的 `recent_repos.json` 路径。
pub fn recent_repos_file(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("定位应用数据目录失败: {e}")))?;
    Ok(dir.join(RECENT_FILE_NAME))
}

/// 检查路径是否仍是磁盘上存在且有效的 Git 工作区。
fn is_valid_repo_dir(path: &Path) -> bool {
    path.is_dir()
        && git2::Repository::open_ext(
            path,
            git2::RepositoryOpenFlags::NO_SEARCH,
            &[] as &[&std::ffi::OsStr],
        )
        .is_ok()
}

/// 读取文件内原始条目；文件不存在或格式损坏时返回空列表。
fn read_raw(file: &Path) -> AppResult<Vec<RecentRepo>> {
    match std::fs::read_to_string(file) {
        Ok(content) => Ok(serde_json::from_str::<Vec<RecentRepo>>(&content).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(AppError::Io(format!(
            "读取最近仓库列表 {} 失败: {e}",
            file.display()
        ))),
    }
}

/// 原子写回最近仓库列表（先建父目录，再写临时文件并重命名）。
fn write_list(file: &Path, list: &[RecentRepo]) -> AppResult<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::Io(format!("创建应用数据目录 {} 失败: {e}", parent.display()))
        })?;
    }
    let json = serde_json::to_string_pretty(list)
        .map_err(|e| AppError::Unexpected(format!("序列化最近仓库列表失败: {e}")))?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, json)
        .map_err(|e| AppError::Io(format!("写入临时文件 {} 失败: {e}", tmp.display())))?;
    std::fs::rename(&tmp, file)
        .map_err(|e| AppError::Io(format!("更新 {} 失败: {e}", file.display())))?;
    Ok(())
}

/// 加载最近仓库列表，并自动剔除已删除或不再是 Git 仓库的失效路径。
pub fn load_recent_repos(file: &Path) -> AppResult<Vec<RecentRepo>> {
    let raw = read_raw(file)?;
    if raw.is_empty() {
        return Ok(Vec::new());
    }

    let mut sorted = raw.clone();
    sorted.sort_by_key(|a| std::cmp::Reverse(a.last_opened_at));

    let mut seen = HashSet::new();
    let mut valid = Vec::with_capacity(sorted.len().min(MAX_RECENT_REPOS));
    for item in sorted {
        if !seen.insert(item.id.clone()) {
            continue;
        }
        if is_valid_repo_dir(Path::new(&item.path)) {
            valid.push(item);
            if valid.len() >= MAX_RECENT_REPOS {
                break;
            }
        }
    }

    if valid != raw {
        write_list(file, &valid)?;
    }
    Ok(valid)
}

/// 将刚刚打开的仓库记录到列表最前，返回更新后的列表。
pub fn record_recent_repo(file: &Path, repo: &RepoInfo, now_ts: i64) -> AppResult<Vec<RecentRepo>> {
    let mut list = load_recent_repos(file)?;
    list.retain(|item| item.id != repo.id && item.path != repo.path);
    list.insert(
        0,
        RecentRepo {
            id: repo.id.clone(),
            path: repo.path.clone(),
            name: repo.name.clone(),
            last_opened_at: now_ts,
        },
    );
    list.truncate(MAX_RECENT_REPOS);
    write_list(file, &list)?;
    Ok(list)
}

/// 从最近仓库列表中手动移除指定路径或 id，返回更新后的列表。
pub fn remove_recent_repo(file: &Path, path_or_id: &str) -> AppResult<Vec<RecentRepo>> {
    let mut list = load_recent_repos(file)?;
    let before = list.len();
    list.retain(|item| item.id != path_or_id && item.path != path_or_id);
    if list.len() != before {
        write_list(file, &list)?;
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RepoState;

    fn make_repo(dir: &Path, name: &str) -> RepoInfo {
        git2::Repository::init(dir).expect("init repo");
        let canonical = std::fs::canonicalize(dir).unwrap();
        let path = canonical.to_string_lossy().into_owned();
        RepoInfo {
            id: path.clone(),
            path,
            name: name.to_string(),
            head_branch: None,
            head_commit: String::new(),
            state: RepoState::Clean,
        }
    }

    #[test]
    fn record_load_prune_and_remove_work() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("recent_repos.json");

        let dir_a = tmp.path().join("repo-a");
        let dir_b = tmp.path().join("repo-b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        let repo_a = make_repo(&dir_a, "repo-a");
        let repo_b = make_repo(&dir_b, "repo-b");

        record_recent_repo(&file, &repo_a, 100).unwrap();
        record_recent_repo(&file, &repo_b, 200).unwrap();
        // 再次打开 repo_a 应提到最前且不重复
        let list = record_recent_repo(&file, &repo_a, 300).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "repo-a");
        assert_eq!(list[1].name, "repo-b");

        // 删除 dir_b：load_recent_repos 自动清理失效条目并写回
        std::fs::remove_dir_all(&dir_b).unwrap();
        let pruned = load_recent_repos(&file).unwrap();
        assert_eq!(pruned.len(), 1);
        assert_eq!(pruned[0].name, "repo-a");

        // 手动移除 repo_a
        let empty = remove_recent_repo(&file, &repo_a.path).unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn corrupted_json_recovers_gracefully() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("recent_repos.json");
        std::fs::write(&file, "{broken json").unwrap();
        let list = load_recent_repos(&file).unwrap();
        assert!(list.is_empty());
    }
}
