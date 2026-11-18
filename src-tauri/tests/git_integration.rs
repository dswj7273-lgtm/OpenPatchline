//! Rust 集成测试（Task 3.4）：基于 tempfile 真实 Git 仓库的端到端场景验证
//!
//! 覆盖：
//! 1. 冲突全流程（merge 冲突 → status → workdir diff 冲突标记 → stage 解决 → continue / abort）
//! 2. 重命名检测（commit / staged / workdir 三种场景）
//! 3. Submodule（主仓库添加子模块后打开、历史、diff、status 均正常）
//! 4. 空仓库（unborn HEAD 打开、暂存/取消暂存、首提交、分支列表）
//! 5. Detached HEAD（状态识别、提交推进、图布局、push 拒绝、切回分支）

use std::path::Path;
use std::process::Command;

use openpatchline_lib::error::AppError;
use openpatchline_lib::graph::GraphState;
use openpatchline_lib::repo_manager::{RepoManager, lock_entry};
use openpatchline_lib::types::{ChangeType, RepoState};
use openpatchline_lib::{git_remote, git_service};

fn run_git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("执行 git 命令失败");
    assert!(
        out.status.success(),
        "git {:?} 失败:\nstdout: {}\nstderr: {}",
        args,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_configured_repo(dir: &Path) -> git2::Repository {
    let repo = git2::Repository::init(dir).expect("init repo");
    let mut cfg = repo.config().expect("read config");
    cfg.set_str("user.name", "Integration Test").unwrap();
    cfg.set_str("user.email", "integration@example.com")
        .unwrap();
    repo
}

fn write_and_commit(dir: &Path, rel: &str, content: &str, msg: &str) -> String {
    let full = dir.join(rel);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&full, content).unwrap();
    run_git(dir, &["add", rel]);
    run_git(dir, &["commit", "-m", msg]);
    run_git(dir, &["rev-parse", "HEAD"])
}

#[test]
fn integration_empty_repo_lifecycle() {
    let tmp = tempfile::tempdir().unwrap();
    let _repo = init_configured_repo(tmp.path());

    let manager = RepoManager::new();
    let info = manager.open(tmp.path()).expect("打开空仓库失败");
    assert_eq!(info.head_commit, "");
    assert_eq!(info.head_branch, None);
    assert_eq!(info.state, RepoState::Clean);

    let entry_arc = manager.entry(&info.id).unwrap();
    let mut entry = lock_entry(&entry_arc);

    assert!(git_service::list_branches(&entry.repo).unwrap().is_empty());
    assert!(matches!(
        git_service::load_commit_page(&entry.repo, None, 20, None),
        Err(AppError::NotFound(_))
    ));

    // 未跟踪 → 暂存 → 取消暂存 → 再暂存并完成首提交
    std::fs::write(tmp.path().join("init.txt"), "hello\n").unwrap();
    let st1 = git_service::status(&entry.repo).unwrap();
    assert_eq!(st1.len(), 1);
    assert_eq!(st1[0].unstaged, Some(ChangeType::Untracked));

    git_service::stage_file(&mut entry.repo, "init.txt").unwrap();
    let st2 = git_service::status(&entry.repo).unwrap();
    assert_eq!(st2[0].staged, Some(ChangeType::Added));

    git_service::unstage_file(&mut entry.repo, "init.txt").unwrap();
    let st3 = git_service::status(&entry.repo).unwrap();
    assert_eq!(st3[0].staged, None);
    assert_eq!(st3[0].unstaged, Some(ChangeType::Untracked));

    git_service::stage_file(&mut entry.repo, "init.txt").unwrap();
    let first_oid = git_service::create_commit(&mut entry.repo, "initial commit").unwrap();
    let after = git_service::repo_info(&entry.repo).unwrap();
    assert_eq!(after.head_commit, first_oid);
    assert!(after.head_branch.is_some());
}

#[test]
fn integration_conflict_diff_resolve_abort_and_continue() {
    let tmp = tempfile::tempdir().unwrap();
    let mut repo = init_configured_repo(tmp.path());
    write_and_commit(tmp.path(), "conflict.txt", "line1\nbase\nline3\n", "base");
    let main_branch = git_service::repo_info(&repo).unwrap().head_branch.unwrap();

    run_git(tmp.path(), &["checkout", "-b", "feat"]);
    write_and_commit(
        tmp.path(),
        "conflict.txt",
        "line1\nfrom-feat\nline3\n",
        "feat change",
    );

    run_git(tmp.path(), &["checkout", &main_branch]);
    let main_tip = write_and_commit(
        tmp.path(),
        "conflict.txt",
        "line1\nfrom-main\nline3\n",
        "main change",
    );

    // 触发真实 merge 冲突
    assert!(git_remote::merge_branch(&repo, tmp.path(), "feat").is_err());
    assert_eq!(
        git_service::repo_info(&repo).unwrap().state,
        RepoState::Merging
    );

    let statuses = git_service::status(&repo).unwrap();
    assert_eq!(statuses.len(), 1);
    assert!(statuses[0].conflicted);

    // 工作区 diff 应包含冲突标记，供用户排查
    let diff = git_service::file_diff_workdir(&repo, "conflict.txt", false).unwrap();
    let joined: String = diff
        .rows
        .iter()
        .filter_map(|r| r.right.as_ref().map(|c| c.content.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(joined.contains("<<<<<<<") && joined.contains(">>>>>>>"));

    // 中止恢复 Clean
    let aborted = git_remote::abort_operation(&repo, tmp.path()).unwrap();
    assert_eq!(aborted.repo.state, RepoState::Clean);
    assert_eq!(aborted.repo.head_commit, main_tip);

    // 再次 merge 冲突 → 解决 → stage → continue 完成双亲提交
    assert!(git_remote::merge_branch(&repo, tmp.path(), "feat").is_err());
    std::fs::write(tmp.path().join("conflict.txt"), "line1\nresolved\nline3\n").unwrap();
    git_service::stage_file(&mut repo, "conflict.txt").unwrap();
    let continued = git_remote::continue_operation(&repo, tmp.path()).unwrap();
    assert_eq!(continued.repo.state, RepoState::Clean);
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
}

#[test]
fn integration_rename_detection_across_scopes() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = init_configured_repo(tmp.path());
    let body = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n";
    write_and_commit(tmp.path(), "old_name.txt", body, "add old_name");

    // 1. 工作区未暂存重命名
    std::fs::rename(
        tmp.path().join("old_name.txt"),
        tmp.path().join("new_name.txt"),
    )
    .unwrap();
    let wdiff = git_service::file_diff_workdir(&repo, "old_name.txt", false).unwrap();
    assert_eq!(wdiff.change_type, ChangeType::Renamed);
    assert_eq!(wdiff.old_path.as_deref(), Some("old_name.txt"));
    assert_eq!(wdiff.new_path.as_deref(), Some("new_name.txt"));

    // 2. 暂存区重命名
    run_git(tmp.path(), &["add", "-A"]);
    let sdiff = git_service::file_diff_staged(&repo, "old_name.txt", false).unwrap();
    assert_eq!(sdiff.change_type, ChangeType::Renamed);
    assert_eq!(sdiff.old_path.as_deref(), Some("old_name.txt"));
    assert_eq!(sdiff.new_path.as_deref(), Some("new_name.txt"));

    // 3. 提交重命名
    run_git(tmp.path(), &["commit", "-m", "rename file"]);
    let head_oid = run_git(tmp.path(), &["rev-parse", "HEAD"]);
    let files = git_service::changed_files(&repo, &head_oid).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].change_type, ChangeType::Renamed);
    assert_eq!(files[0].path, "new_name.txt");
    assert_eq!(files[0].old_path.as_deref(), Some("old_name.txt"));
}

#[test]
fn integration_submodule_repository_operations() {
    let root_tmp = tempfile::tempdir().unwrap();
    let sub_tmp = tempfile::tempdir().unwrap();

    // 构造本地子模块源仓库
    let _sub_repo = init_configured_repo(sub_tmp.path());
    write_and_commit(sub_tmp.path(), "lib.rs", "pub fn hello() {}\n", "sub init");

    // 主仓库添加子模块
    let _main_repo = init_configured_repo(root_tmp.path());
    write_and_commit(root_tmp.path(), "README.md", "# main\n", "main init");
    let sub_url = sub_tmp.path().to_string_lossy().into_owned();
    run_git(
        root_tmp.path(),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            &sub_url,
            "deps/sub",
        ],
    );
    run_git(root_tmp.path(), &["commit", "-m", "add submodule"]);
    let sub_commit = run_git(root_tmp.path(), &["rev-parse", "HEAD"]);

    let manager = RepoManager::new();
    let main_info = manager
        .open(root_tmp.path())
        .expect("打开含子模块的主仓库失败");
    let entry_arc = manager.entry(&main_info.id).unwrap();
    let entry = lock_entry(&entry_arc);

    // 读取含 gitlink 的历史、变更文件、diff 与工作区状态均不应崩溃
    let (commits, _) = git_service::load_commit_page(&entry.repo, None, 20, None).unwrap();
    assert_eq!(commits.len(), 2);

    let files = git_service::changed_files(&entry.repo, &sub_commit).unwrap();
    assert!(files.iter().any(|f| f.path == ".gitmodules"));
    assert!(files.iter().any(|f| f.path == "deps/sub"));

    // 对 gitlink 条目查 diff 应优雅处理为非 blob（空内容）而不报错
    let _gitlink_diff =
        git_service::file_diff_commit(&entry.repo, &sub_commit, "deps/sub", false).unwrap();
    let statuses = git_service::status(&entry.repo).unwrap();
    assert!(statuses.is_empty(), "提交后子模块工作区应干净");
}

#[test]
fn integration_detached_head_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let mut repo = init_configured_repo(tmp.path());
    let c1 = write_and_commit(tmp.path(), "a.txt", "v1\n", "c1");
    let _c2 = write_and_commit(tmp.path(), "a.txt", "v2\n", "c2");
    let main_branch = git_service::repo_info(&repo).unwrap().head_branch.unwrap();

    // 检出到 c1 进入 detached HEAD
    run_git(tmp.path(), &["checkout", &c1]);
    let detached_info = git_service::repo_info(&repo).unwrap();
    assert_eq!(detached_info.head_branch, None);
    assert_eq!(detached_info.head_commit, c1);

    // 在 detached HEAD 上新建提交并计算图布局
    std::fs::write(tmp.path().join("detached.txt"), "d1\n").unwrap();
    git_service::stage_file(&mut repo, "detached.txt").unwrap();
    let c3 = git_service::create_commit(&mut repo, "detached work").unwrap();
    assert_eq!(git_service::repo_info(&repo).unwrap().head_commit, c3);

    let (page, _) = git_service::load_commit_page(&repo, None, 20, None).unwrap();
    let mut gs = GraphState::new();
    let rows = gs.compute_graph_rows(page);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].commit.id, c3);

    // detached HEAD 禁止直接推送
    assert!(matches!(
        git_remote::push(&repo, tmp.path()),
        Err(AppError::InvalidArg(_))
    ));

    // 切回主分支恢复
    git_service::checkout_branch(&mut repo, &main_branch).unwrap();
    assert_eq!(
        git_service::repo_info(&repo)
            .unwrap()
            .head_branch
            .as_deref(),
        Some(main_branch.as_str())
    );
}

/// v0.8 / 8.1 端到端旅程：打开仓库 → 修改 → 暂存 → 提交 → 推送（本地裸远程），
/// 全程经应用自身的命令层实现（RepoManager + git_service + git_remote）。
#[test]
fn integration_full_journey_open_stage_commit_push_fetch() {
    // 1. 准备裸远程与首个提交（经 CLI 建立远端历史）
    let remote_tmp = tempfile::tempdir().expect("创建远程目录失败");
    {
        let bare = git2::Repository::init_bare(remote_tmp.path()).expect("init bare");
        drop(bare);
    }
    let work_tmp = tempfile::tempdir().expect("创建工作目录失败");
    init_configured_repo(work_tmp.path());
    write_and_commit(work_tmp.path(), "README.md", "# hello\n", "initial");
    run_git(
        work_tmp.path(),
        &[
            "remote",
            "add",
            "origin",
            remote_tmp.path().to_str().unwrap(),
        ],
    );
    run_git(work_tmp.path(), &["push", "-u", "origin", "HEAD"]);

    // 2. 经 RepoManager 打开（应用打开仓库的路径）
    let manager = RepoManager::new();
    let info = manager.open(work_tmp.path()).expect("打开仓库失败");

    // 3. 修改文件 → 应用侧读取状态
    std::fs::write(work_tmp.path().join("README.md"), "# hello v2\n").expect("写入失败");
    let entry = manager.entry(&info.id).expect("取条目失败");
    {
        let e = lock_entry(&entry);
        let statuses = git_service::status(&e.repo).expect("读取状态失败");
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].unstaged, Some(ChangeType::Modified));
    }

    // 4. 暂存 → 提交（应用侧写路径）
    {
        let mut e = lock_entry(&entry);
        git_service::stage_file(&mut e.repo, "README.md").expect("暂存失败");
        let new_id = git_service::create_commit(&mut e.repo, "feat: bump to v2").expect("提交失败");
        assert_eq!(new_id.len(), 40);
    }

    // 5. 推送到远程（应用侧 push 路径）
    {
        let e = lock_entry(&entry);
        let workdir = e.repo.workdir().unwrap().to_path_buf();
        git_remote::push(&e.repo, &workdir).expect("推送失败");
    }

    // 6. 远程确实收到了新提交：浅验证 —— 在远程裸仓库上读取 HEAD 提交说明
    {
        let bare = git2::Repository::open_bare(remote_tmp.path()).expect("打开裸远程");
        let head = bare
            .find_reference("refs/heads/master")
            .or_else(|_| bare.find_reference("refs/heads/main"))
            .expect("读取远程 HEAD")
            .peel_to_commit()
            .expect("解析远程 HEAD");
        assert_eq!(head.message().unwrap().trim(), "feat: bump to v2");
    }

    // 7. 再次 fetch（应用侧）应无新对象但不报错
    {
        let e = lock_entry(&entry);
        let workdir = e.repo.workdir().unwrap().to_path_buf();
        git_remote::fetch(&e.repo, &workdir, None).expect("fetch 失败");
    }
    // commit-graph 维护不破坏仓库
    assert!(work_tmp.path().join(".git").exists());
}
