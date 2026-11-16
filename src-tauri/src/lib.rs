//! OpenPatchline 主进程库：模块声明 + Tauri 应用入口。
//!
//! 模块均为 `pub`：lib 目标（rlib）可被集成测试直接使用。
//!
//! - [`types`]：跨进程（Rust ↔ TypeScript）线格式类型；
//! - [`error`]：统一错误类型 [`crate::error::AppError`]；
//! - [`git_service`]：git2 本地仓库操作的高层 API；
//! - [`git_remote`]：fetch / pull 远程操作（git CLI 子进程）；
//! - [`graph`]：提交图泳道布局引擎；
//! - [`diff_engine`]：行级 / 字符级 diff 计算；
//! - [`repo_manager`]：已打开仓库表（repo_id → 仓库 + 图状态）；
//! - [`watcher`]：.git 目录监听（变更主动推送，docs/04 §7）；
//! - [`commands`]：Tauri 命令层（前端 invoke 入口）。

pub mod commands;
pub mod diff_engine;
pub mod error;
pub mod git_remote;
pub mod git_service;
pub mod graph;
pub mod repo_manager;
pub mod types;
pub mod watcher;

/// 应用入口：注册插件、全局状态与全部命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
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
            commands::create_commit,
            commands::list_branches,
            commands::checkout_branch,
            commands::fetch_repository,
            commands::pull_repository,
            commands::push_repository,
            commands::fetch_all_remotes,
            commands::pull_rebase_repository,
            commands::push_force_with_lease_repository,
            commands::push_tags_repository,
            commands::create_branch,
            commands::delete_branch,
            commands::merge_branch,
            commands::create_tag,
            commands::cherry_pick_commit,
            commands::revert_commit,
            commands::reset_head,
            commands::discard_file,
            commands::discard_all,
            commands::amend_commit,
            commands::list_stashes,
            commands::stash_push,
            commands::stash_apply,
            commands::stash_drop
        ])
        // watcher 需要 AppHandle（emit 事件），在 setup 阶段注册为全局状态。
        .setup(|app| {
            app.manage(watcher::RepoWatcher::new(app.handle().clone()));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
