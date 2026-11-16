//! 本地日志模块：将后端与前端上报的错误写入 `app_data_dir/logs/openpatchline.log`。
//!
//! - 支持 2MB 自动轮转（保留 `.log.1` 备份），避免长期运行占用过大磁盘空间；
//! - 核心写入函数接收显式文件路径，便于单元测试用 `tempfile` 隔离验证。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use crate::error::{AppError, AppResult};

const LOG_DIR_NAME: &str = "logs";
const LOG_FILE_NAME: &str = "openpatchline.log";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 4000;

static LOG_LOCK: Mutex<()> = Mutex::new(());

/// 返回本地日志文件路径（`app_data_dir/logs/openpatchline.log`）。
pub fn log_file(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("定位应用数据目录失败: {e}")))?;
    Ok(dir.join(LOG_DIR_NAME).join(LOG_FILE_NAME))
}

fn unix_secs_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 规整日志文本为单行并截断过长内容，防止巨型栈帧写满日志。
fn sanitize_line(raw: &str) -> String {
    let single: String = raw
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    single.trim().to_string()
}

/// 追加一条日志到指定文件（超出 2MB 时自动轮转为 `.log.1`）。
pub fn append_log(file: &Path, level: &str, source: &str, message: &str) -> AppResult<()> {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Io(format!("创建日志目录 {} 失败: {e}", parent.display())))?;
    }
    if let Ok(meta) = fs::metadata(file)
        && meta.len() >= MAX_LOG_BYTES
    {
        let backup = file.with_extension("log.1");
        let _ = fs::remove_file(&backup);
        let _ = fs::rename(file, &backup);
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .map_err(|e| AppError::Io(format!("打开日志文件 {} 失败: {e}", file.display())))?;
    let lvl = level.trim().to_ascii_uppercase();
    let src = sanitize_line(source);
    let msg = sanitize_line(message);
    writeln!(f, "[{}] [{}] [{}] {}", unix_secs_now(), lvl, src, msg)
        .map_err(|e| AppError::Io(format!("写入日志文件失败: {e}")))?;
    Ok(())
}

/// 尽力记录后端错误（忽略 `Cancelled` 与写入自身失败，不影响主流程）。
pub fn log_backend_error(app: &tauri::AppHandle, source: &str, err: &AppError) {
    if matches!(err, AppError::Cancelled) {
        return;
    }
    if let Ok(file) = log_file(app) {
        let _ = append_log(&file, "ERROR", source, &err.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_log_creates_and_sanitizes_lines() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("logs/openpatchline.log");

        append_log(&file, "error", "diff", "line1\nline2\r\n").unwrap();
        append_log(&file, "warn", "git", "something happened").unwrap();

        let text = fs::read_to_string(&file).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("[ERROR] [diff] line1 line2"));
        assert!(lines[1].contains("[WARN] [git] something happened"));
    }

    #[test]
    fn append_log_rotates_over_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("openpatchline.log");
        let big = vec![b'x'; (MAX_LOG_BYTES as usize) + 16];
        fs::write(&file, big).unwrap();

        append_log(&file, "info", "test", "after rotate").unwrap();

        let backup = dir.path().join("openpatchline.log.1");
        assert!(backup.exists(), "超限后应生成 .log.1 备份");
        let current = fs::read_to_string(&file).unwrap();
        assert!(current.contains("after rotate"));
        assert!(current.len() < 512);
    }
}
