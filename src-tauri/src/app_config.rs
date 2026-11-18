//! 应用设置持久化（存放在 Tauri app_data_dir 下 `settings.json`）。
//!
//! 设置结构 [`AppConfig`] 与前端 `AppSettings` 一一对应（camelCase 线格式）。
//! 读写接受显式文件路径便于单元测试；损坏或缺失的配置回退到默认值，
//! 数值项在读入时夹取到安全区间，避免异常值破坏布局。

use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::error::{AppError, AppResult};

/// 设置文件名（位于 app_data_dir 下）。
const SETTINGS_FILE_NAME: &str = "settings.json";
/// 代码字号安全区间（px）。
const FONT_SIZE_MIN: u32 = 10;
const FONT_SIZE_MAX: u32 = 24;
/// Tab 宽度安全区间（列数）。
const TAB_WIDTH_MIN: u32 = 1;
const TAB_WIDTH_MAX: u32 = 16;

/// 应用设置（v0.6 / 6.2）。新增字段必须给出默认值（`#[serde(default)]`
/// 由 `Default` 实现兜底），保证旧版本写入的 settings.json 仍可读取。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// 主题偏好：跟随系统 / 深色 / 浅色。
    pub theme: String,
    /// 代码字体族；空串表示使用内置默认字体栈。
    pub code_font_family: String,
    /// 代码字号（px）。
    pub code_font_size: u32,
    /// Tab 宽度（列数）。
    pub tab_width: u32,
    /// 默认 Diff 视图模式：split / unified。
    pub default_diff_mode: String,
    /// Diff 忽略空白默认值。
    pub ignore_whitespace_default: bool,
    /// 外部编辑器命令模板，支持 `{path}` 与 `{line}` 占位符；None 表示未配置。
    pub external_editor_command: Option<String>,
    /// Git 可执行文件路径覆盖；None 表示自动探测。
    pub git_executable_path: Option<String>,
    /// 首次启动引导（v1.0 / 10.4）：用户已跳过或完成，不再自动弹出。
    pub onboarding_dismissed: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            code_font_family: String::new(),
            code_font_size: 12,
            tab_width: 4,
            default_diff_mode: "split".to_string(),
            ignore_whitespace_default: false,
            external_editor_command: None,
            git_executable_path: None,
            onboarding_dismissed: false,
        }
    }
}

impl AppConfig {
    /// 把读入的配置规整到安全取值：非法枚举回退默认、数值夹取区间、
    /// 空白路径视为未配置。持久化与返回给前端前统一调用。
    pub fn normalized(self) -> Self {
        let theme = match self.theme.as_str() {
            "system" | "dark" | "light" => self.theme,
            _ => AppConfig::default().theme,
        };
        let default_diff_mode = match self.default_diff_mode.as_str() {
            "split" | "unified" => self.default_diff_mode,
            _ => AppConfig::default().default_diff_mode,
        };
        Self {
            theme,
            code_font_family: self.code_font_family.trim().to_string(),
            code_font_size: self.code_font_size.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX),
            tab_width: self.tab_width.clamp(TAB_WIDTH_MIN, TAB_WIDTH_MAX),
            default_diff_mode,
            ignore_whitespace_default: self.ignore_whitespace_default,
            external_editor_command: self
                .external_editor_command
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            git_executable_path: self
                .git_executable_path
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            onboarding_dismissed: self.onboarding_dismissed,
        }
    }
}

/// 解析应用数据目录下的 `settings.json` 路径。
pub fn app_config_file(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("定位应用数据目录失败: {e}")))?;
    Ok(dir.join(SETTINGS_FILE_NAME))
}

/// 读取设置；文件不存在或损坏时返回默认值（`fresh = true` 表示尚未持久化过，
/// 前端可借此做一次性旧数据迁移）。
pub fn load_app_config(file: &Path) -> AppResult<(AppConfig, bool)> {
    match std::fs::read_to_string(file) {
        Ok(content) => {
            let cfg = serde_json::from_str::<AppConfig>(&content)
                .unwrap_or_default()
                .normalized();
            Ok((cfg, false))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((AppConfig::default(), true)),
        Err(e) => Err(AppError::Io(format!(
            "读取设置 {} 失败: {e}",
            file.display()
        ))),
    }
}

/// 原子写入设置（先建父目录，再写临时文件并重命名）。
pub fn save_app_config(file: &Path, cfg: &AppConfig) -> AppResult<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::Io(format!("创建应用数据目录 {} 失败: {e}", parent.display()))
        })?;
    }
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| AppError::Unexpected(format!("序列化设置失败: {e}")))?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, json)
        .map_err(|e| AppError::Io(format!("写入临时文件 {} 失败: {e}", tmp.display())))?;
    std::fs::rename(&tmp, file)
        .map_err(|e| AppError::Io(format!("更新 {} 失败: {e}", file.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_valid_and_fresh_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        let (cfg, fresh) = load_app_config(&file).unwrap();
        assert!(fresh);
        assert_eq!(cfg, AppConfig::default());
        assert_eq!(cfg.theme, "system");
        assert_eq!(cfg.default_diff_mode, "split");
    }

    #[test]
    fn save_then_load_roundtrip_normalizes() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        let cfg = AppConfig {
            theme: "light".into(),
            code_font_family: " Fira Code ".into(),
            code_font_size: 99,
            tab_width: 0,
            default_diff_mode: "unified".into(),
            ignore_whitespace_default: true,
            external_editor_command: Some("  ".into()),
            git_executable_path: Some("/usr/local/bin/git".into()),
            onboarding_dismissed: false,
        };
        save_app_config(&file, &cfg.clone().normalized()).unwrap();
        let (loaded, fresh) = load_app_config(&file).unwrap();
        assert!(!fresh);
        assert_eq!(loaded.code_font_family, "Fira Code");
        assert_eq!(loaded.code_font_size, FONT_SIZE_MAX);
        assert_eq!(loaded.tab_width, TAB_WIDTH_MIN);
        assert_eq!(loaded.external_editor_command, None);
        assert_eq!(
            loaded.git_executable_path.as_deref(),
            Some("/usr/local/bin/git")
        );
    }

    #[test]
    fn corrupted_json_falls_back_to_default() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        std::fs::write(&file, "{broken").unwrap();
        let (cfg, fresh) = load_app_config(&file).unwrap();
        assert!(!fresh); // 文件存在即非首次运行，只是内容损坏回退默认
        assert_eq!(cfg, AppConfig::default());
    }

    #[test]
    fn legacy_json_with_missing_fields_loads() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        std::fs::write(&file, r#"{"theme":"dark"}"#).unwrap();
        let (cfg, _) = load_app_config(&file).unwrap();
        assert_eq!(cfg.theme, "dark");
        assert_eq!(cfg.code_font_size, 12); // 缺失字段回退默认
    }

    /// v1.0 / 10.4：旧配置（无引导标记）读入后引导未完成；跳过后持久化。
    #[test]
    fn onboarding_flag_defaults_and_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        std::fs::write(&file, r#"{"theme":"dark"}"#).unwrap();
        let (cfg, _) = load_app_config(&file).unwrap();
        assert!(!cfg.onboarding_dismissed, "旧配置应视为未完成引导");

        let dismissed = AppConfig {
            onboarding_dismissed: true,
            ..cfg
        };
        save_app_config(&file, &dismissed).unwrap();
        let (loaded, _) = load_app_config(&file).unwrap();
        assert!(loaded.onboarding_dismissed);
    }
}
