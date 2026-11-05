//! OpenPatchline 主进程库：模块声明 + Tauri 应用入口。
//!
//! 模块均为 `pub`：lib 目标（rlib）可被集成测试直接使用。
//!
//! - [`types`]：跨进程（Rust ↔ TypeScript）线格式类型；
//! - [`error`]：统一错误类型 [`crate::error::AppError`]；
//! - [`git_service`]：git2 本地仓库操作的高层 API；
//! - [`graph`]：提交图泳道布局引擎；
//! - [`diff_engine`]：行级 / 字符级 diff 计算；
//! - [`repo_manager`]：已打开仓库表（repo_id → 仓库 + 图状态）；
//! - [`commands`]：Tauri 命令层（前端 invoke 入口）。

pub mod commands;
pub mod diff_engine;
pub mod error;
pub mod git_service;
pub mod graph;
pub mod repo_manager;
pub mod types;

/// 应用入口：注册插件、全局状态与全部命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(repo_manager::RepoManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::pick_and_open_repository,
            commands::get_commit_graph,
            commands::get_commit_files,
            commands::get_file_diff,
            commands::get_file_status,
            commands::stage_file,
            commands::unstage_file,
            commands::create_commit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
