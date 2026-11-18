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

pub mod app_config;
pub mod commands;
pub mod diff_engine;
pub mod error;
pub mod external;
pub mod git_remote;
pub mod git_service;
pub mod graph;
pub mod logger;
pub mod recent_repos;
pub mod repo_manager;
pub mod types;
pub mod watcher;

/// 应用入口：注册插件、全局状态、原生菜单与全部命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Emitter;
    use tauri::{
        Manager,
        menu::{MenuBuilder, MenuItem, SubmenuBuilder},
    };

    fn build_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
        // 菜单项 id 与前端 keymap 注册表（src/keyboard/keymap.ts）对齐，
        // 事件统一以 `app_menu_action` 推送、由 runAppAction 路由。
        let open_repo =
            MenuItem::with_id(app, "open-repo", "打开仓库…", true, Some("CmdOrCtrl+O"))?;
        let refresh = MenuItem::with_id(app, "refresh", "刷新", true, Some("CmdOrCtrl+R"))?;
        let file_menu = SubmenuBuilder::new(app, "文件")
            .item(&open_repo)
            .item(&refresh)
            .separator()
            .quit()
            .build()?;

        let edit_menu = SubmenuBuilder::new(app, "编辑")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let palette = MenuItem::with_id(
            app,
            "command-palette",
            "命令面板…",
            true,
            Some("CmdOrCtrl+K"),
        )?;
        let search = MenuItem::with_id(app, "search", "搜索提交", true, Some("CmdOrCtrl+F"))?;
        let theme = MenuItem::with_id(
            app,
            "toggle-theme",
            "切换深 / 浅主题",
            true,
            Some("CmdOrCtrl+Shift+T"),
        )?;
        let settings =
            MenuItem::with_id(app, "open-settings", "设置…", true, Some("CmdOrCtrl+Comma"))?;
        let view_menu = SubmenuBuilder::new(app, "视图")
            .item(&palette)
            .item(&search)
            .item(&theme)
            .separator()
            .item(&settings)
            .build()?;

        let window_menu = SubmenuBuilder::new(app, "窗口")
            .minimize()
            .separator()
            .close_window()
            .build()?;

        let menu = MenuBuilder::new(app)
            .items(&[&file_menu, &edit_menu, &view_menu, &window_menu])
            .build()?;
        app.set_menu(menu).map(|_| ())
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(repo_manager::RepoManager::new())
        .manage(git_remote::RemoteOpManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::pick_and_open_repository,
            commands::get_repo_info,
            commands::get_recent_repositories,
            commands::remove_recent_repository,
            commands::get_commit_graph,
            commands::get_commit_files,
            commands::get_range_files,
            commands::get_file_diff,
            commands::apply_diff_selection,
            commands::get_file_status,
            commands::stage_file,
            commands::unstage_file,
            commands::create_commit,
            commands::get_commit_metadata,
            commands::get_commit_signature,
            commands::list_rebase_commits,
            commands::rewrite_recent_commits,
            commands::list_branches,
            commands::checkout_branch,
            commands::fetch_repository,
            commands::pull_repository,
            commands::push_repository,
            commands::fetch_all_remotes,
            commands::pull_rebase_repository,
            commands::push_force_with_lease_repository,
            commands::push_tags_repository,
            commands::cancel_remote_operation,
            commands::create_branch,
            commands::delete_branch,
            commands::merge_branch,
            commands::abort_operation,
            commands::continue_operation,
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
            commands::stash_drop,
            commands::log_client_error,
            commands::get_log_file_path,
            commands::get_conflict_file,
            commands::resolve_conflict_file,
            commands::get_file_blame,
            commands::get_app_config,
            commands::set_app_config,
            commands::reveal_path_in_finder,
            commands::open_file_in_editor,
            commands::generate_file_patch,
            commands::pick_git_executable,
            commands::get_file_history,
            commands::get_stash_files,
            commands::list_branches_containing,
            commands::stash_branch,
            commands::interactive_rebase,
            commands::checkout_file_from,
            commands::list_safety_backups,
            commands::restore_safety_backup,
            commands::get_diagnostics,
            commands::reveal_log_file
        ])
        // watcher 需要 AppHandle（emit 事件），在 setup 阶段注册为全局状态；
        // 同时构建原生菜单（快捷键在 macOS 菜单栏可见）并预加载应用设置。
        .setup(|app| {
            app.manage(watcher::RepoWatcher::new(app.handle().clone()));
            // panic 本地化记录（v0.8 / 8.7）：默认 hook 之外写入应用日志，
            // 设置页提供"打开日志目录 / 复制诊断信息"入口。
            if let Ok(log) = logger::log_file(app.handle()) {
                let default_hook = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    let bt = std::backtrace::Backtrace::force_capture();
                    let msg = format!("{info}\n{bt}");
                    let _ = logger::append_log(&log, "error", "panic", &msg);
                    default_hook(info);
                }));
            }
            if let Err(e) = build_menu(app.handle()) {
                eprintln!("[menu] 构建原生菜单失败: {e}");
            }
            app.on_menu_event(|app, event| {
                let _ = app.emit("app_menu_action", event.id().as_ref());
            });
            if let Ok(file) = app_config::app_config_file(app.handle())
                && let Ok((config, _)) = app_config::load_app_config(&file)
            {
                git_remote::set_git_bin_override(config.git_executable_path.as_deref());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
