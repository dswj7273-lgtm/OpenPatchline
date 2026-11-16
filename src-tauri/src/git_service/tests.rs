use super::*;
use crate::types::{BranchKind, FileStatus, LineKind, RefKind};

/// 固定测试签名，避免依赖机器上的全局 git 配置。
fn sig() -> git2::Signature<'static> {
    git2::Signature::now("Test User", "test@example.com").expect("构造签名失败")
}

/// 初始化临时仓库，并把 user.name/user.email 写入仓库本地配置，
/// 使 `repo.signature()` 确定性可用。
fn init_repo() -> (tempfile::TempDir, git2::Repository) {
    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let repo = git2::Repository::init(dir.path()).expect("初始化仓库失败");
    let mut config = repo.config().expect("读取仓库配置失败");
    config
        .set_str("user.name", "Test User")
        .expect("设置 user.name 失败");
    config
        .set_str("user.email", "test@example.com")
        .expect("设置 user.email 失败");
    (dir, repo)
}

/// 写入工作区文件、加入 index 并提交（覆盖式），返回新提交 id。
fn commit_file(repo: &git2::Repository, path: &str, content: &str, message: &str) -> String {
    let file_path = repo.workdir().expect("仓库应有工作区").join(path);
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).expect("创建目录失败");
    }
    std::fs::write(&file_path, content).expect("写入文件失败");

    let mut index = repo.index().expect("读取 index 失败");
    index.add_path(Path::new(path)).expect("add_path 失败");
    index.write().expect("写回 index 失败");
    let tree_oid = index.write_tree_to(repo).expect("write_tree 失败");
    let tree = repo.find_tree(tree_oid).expect("find_tree 失败");
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

/// 按 path 查找状态条目。
fn find_status<'a>(statuses: &'a [FileStatus], path: &str) -> Option<&'a FileStatus> {
    statuses.iter().find(|s| s.path == path)
}

/// 子仓库扫描：只返回含 .git 的直接子目录，按名称排序；忽略普通目录与文件。
#[test]
fn list_child_repos_finds_direct_children_only() {
    let dir = tempfile::tempdir().expect("创建临时目录失败");
    // 两个仓库 + 一个普通目录 + 一个普通文件 + 一个嵌套仓库（不应被发现）。
    for name in ["z-repo", "a-repo"] {
        git2::Repository::init(dir.path().join(name)).expect("初始化子仓库失败");
    }
    std::fs::create_dir_all(dir.path().join("plain-dir/nested-repo")).expect("创建目录失败");
    git2::Repository::init(dir.path().join("plain-dir/nested-repo")).expect("初始化嵌套仓库失败");
    std::fs::write(dir.path().join("file.txt"), "x").expect("写入文件失败");

    let repos = super::list_child_repos(dir.path());
    let names: Vec<&str> = repos.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, vec!["a-repo", "z-repo"], "仅一层子仓库，按名称排序");
    assert!(repos[0].path.ends_with("a-repo"));
}

/// (1) 线性 3 提交：每页 2 条 + cursor 续页，has_more 正确。
#[test]
fn commit_page_pagination() {
    let (_dir, repo) = init_repo();
    let c1 = commit_file(&repo, "a.txt", "v1\n", "commit 1");
    let c2 = commit_file(&repo, "a.txt", "v2\n", "commit 2");
    let c3 = commit_file(&repo, "a.txt", "v3\n", "commit 3");

    let (page1, has_more) = load_commit_page(&repo, None, 2, None).expect("读取第一页失败");
    assert!(has_more, "还剩 1 条提交，应有下一页");
    let ids: Vec<&str> = page1.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, vec![c3.as_str(), c2.as_str()]);

    // cursor = 第一页最后一条（c2），从其之后继续。
    let (page2, has_more2) = load_commit_page(&repo, Some(&c2), 2, None).expect("读取第二页失败");
    assert!(!has_more2, "历史已读完");
    let ids2: Vec<&str> = page2.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids2, vec![c1.as_str()]);
}

/// (2) 提交上的引用标签包含 Head 与 Local（分支名一致）。
#[test]
fn refs_labels_contain_head_and_branch() {
    let (_dir, repo) = init_repo();
    let head = commit_file(&repo, "a.txt", "v1\n", "initial");

    let info = repo_info(&repo).expect("repo_info 失败");
    assert_eq!(info.head_commit, head);
    assert!(info.head_branch.is_some());

    let (page, _) = load_commit_page(&repo, None, 10, None).expect("读取历史失败");
    assert_eq!(page.len(), 1);
    let branch_name = info.head_branch.expect("head_branch 应存在");
    let labels = &page[0].refs;
    assert!(
        labels
            .iter()
            .any(|l| l.name == branch_name && matches!(l.kind, RefKind::Head))
    );
    assert!(
        labels
            .iter()
            .any(|l| l.name == branch_name && matches!(l.kind, RefKind::Local))
    );
}

/// 构造“修改一行 + 新增一行”的两提交仓库，返回修改提交 id。
fn modified_repo() -> (tempfile::TempDir, git2::Repository, String) {
    let (dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "line1\nline2\n", "initial");
    let c2 = commit_file(&repo, "a.txt", "line1\nchanged\nline3\n", "modify");
    (dir, repo, c2)
}

/// (3) changed_files：Modified + 精确的 +/- 行数。
#[test]
fn changed_files_modified_counts() {
    let (_dir, repo, c2) = modified_repo();
    let files = changed_files(&repo, &c2).expect("changed_files 失败");
    assert_eq!(files.len(), 1);
    let f = &files[0];
    assert_eq!(f.path, "a.txt");
    assert!(f.old_path.is_none());
    assert!(matches!(f.change_type, ChangeType::Modified));
    assert_eq!(
        (f.additions, f.deletions),
        (2, 1),
        "新增 changed/line3，删除 line2"
    );
}

/// (4) file_diff_commit：修改行呈现为左 Removed / 右 Added 的行对。
#[test]
fn file_diff_commit_rows() {
    let (_dir, repo, c2) = modified_repo();
    let result = file_diff_commit(&repo, &c2, "a.txt").expect("file_diff_commit 失败");
    assert!(!result.is_binary);
    assert!(!result.too_large);
    assert!(matches!(result.change_type, ChangeType::Modified));
    assert_eq!((result.additions, result.deletions), (2, 1));

    let has_removed = result.rows.iter().any(|r| {
        r.left
            .as_ref()
            .is_some_and(|c| c.kind == LineKind::Removed && c.content == "line2")
    });
    let has_added = result.rows.iter().any(|r| {
        r.right
            .as_ref()
            .is_some_and(|c| c.kind == LineKind::Added && c.content == "changed")
    });
    assert!(has_removed, "左侧应出现 Removed 的 line2");
    assert!(has_added, "右侧应出现 Added 的 changed");
    assert!(!result.change_row_indices.is_empty());
}

/// (5) status：修改（unstaged）、暂存（staged）、未跟踪（Untracked）。
#[test]
fn status_staged_unstaged_untracked() {
    let (_dir, mut repo) = init_repo();
    commit_file(&repo, "a.txt", "v1\n", "initial");

    // 修改已跟踪文件 + 新增未跟踪文件。
    std::fs::write(
        repo.workdir().expect("工作区").join("a.txt"),
        "v1 modified\n",
    )
    .expect("写入失败");
    std::fs::write(repo.workdir().expect("工作区").join("new.txt"), "new\n").expect("写入失败");

    let statuses = status(&repo).expect("status 失败");
    let a = find_status(&statuses, "a.txt").expect("a.txt 应在状态中");
    assert!(matches!(a.unstaged, Some(ChangeType::Modified)));
    assert!(a.staged.is_none());
    let n = find_status(&statuses, "new.txt").expect("new.txt 应在状态中");
    assert!(matches!(n.unstaged, Some(ChangeType::Untracked)));
    assert!(n.staged.is_none());

    // 暂存后：a.txt 移到 staged 栏。
    stage_file(&mut repo, "a.txt").expect("stage 失败");
    let statuses = status(&repo).expect("status 失败");
    let a = find_status(&statuses, "a.txt").expect("a.txt 应在状态中");
    assert!(matches!(a.staged, Some(ChangeType::Modified)));
    assert!(a.unstaged.is_none());
}

/// 目录级暂存：stage_file 传目录路径时，目录下全部文件一次性进入暂存区。
#[test]
fn stage_directory_stages_all_inside() {
    let (_dir, mut repo) = init_repo();
    commit_file(&repo, "root.txt", "v1\n", "initial");

    let workdir = repo.workdir().expect("工作区").to_path_buf();
    std::fs::create_dir_all(workdir.join("feat/sub")).expect("创建目录失败");
    std::fs::write(workdir.join("feat/one.java"), "1\n").expect("写入失败");
    std::fs::write(workdir.join("feat/sub/two.java"), "2\n").expect("写入失败");

    let before = status(&repo).expect("状态失败");
    assert_eq!(
        before
            .iter()
            .filter(|s| s.unstaged == Some(ChangeType::Untracked))
            .count(),
        2,
        "两个新文件均未跟踪"
    );

    super::stage_file(&mut repo, "feat").expect("目录暂存失败");

    let after = status(&repo).expect("状态失败");
    for path in ["feat/one.java", "feat/sub/two.java"] {
        let entry = find_status(&after, path).expect("应出现在状态里");
        assert_eq!(entry.staged, Some(ChangeType::Added), "{path} 应已暂存");
        assert!(entry.unstaged.is_none(), "{path} 不应再有未暂存变更");
    }
}

/// (6) stage / unstage / create_commit 往返：提交 id 返回且出现在历史中。
#[test]
fn stage_unstage_commit_roundtrip() {
    let (_dir, mut repo) = init_repo();
    commit_file(&repo, "a.txt", "v1\n", "initial");

    // 修改 + 暂存。
    std::fs::write(repo.workdir().expect("工作区").join("a.txt"), "v2\n").expect("写入失败");
    stage_file(&mut repo, "a.txt").expect("stage 失败");
    let statuses = status(&repo).expect("status 失败");
    let a = find_status(&statuses, "a.txt").expect("a.txt 应在状态中");
    assert!(matches!(a.staged, Some(ChangeType::Modified)));

    // unstage：回到 unstaged。
    unstage_file(&mut repo, "a.txt").expect("unstage 失败");
    let statuses = status(&repo).expect("status 失败");
    let a = find_status(&statuses, "a.txt").expect("a.txt 应在状态中");
    assert!(a.staged.is_none());
    assert!(matches!(a.unstaged, Some(ChangeType::Modified)));

    // 新文件 stage 后 unstage：回到未跟踪。
    std::fs::write(repo.workdir().expect("工作区").join("b.txt"), "b\n").expect("写入失败");
    stage_file(&mut repo, "b.txt").expect("stage 失败");
    let statuses = status(&repo).expect("status 失败");
    assert!(matches!(
        find_status(&statuses, "b.txt")
            .expect("b.txt 应在状态中")
            .staged,
        Some(ChangeType::Added)
    ));
    unstage_file(&mut repo, "b.txt").expect("unstage 失败");
    let statuses = status(&repo).expect("status 失败");
    let b = find_status(&statuses, "b.txt").expect("b.txt 应在状态中");
    assert!(b.staged.is_none());
    assert!(matches!(b.unstaged, Some(ChangeType::Untracked)));

    stage_file(&mut repo, "a.txt").expect("stage 失败");
    let oid = create_commit(&mut repo, "second").expect("create_commit 失败");
    assert_eq!(oid.len(), 40);

    let (page, _) = load_commit_page(&repo, None, 10, None).expect("读取历史失败");
    assert_eq!(page.len(), 2, "initial + second 共 2 条提交");
    assert_eq!(page[0].id, oid);
    assert_eq!(page[0].message, "second");
    assert_eq!(page[0].short_id.len(), 7);

    // 提交后工作区干净（b.txt 仍未跟踪）。
    let statuses = status(&repo).expect("status 失败");
    assert!(find_status(&statuses, "a.txt").is_none());
    assert!(find_status(&statuses, "b.txt").is_some());
}

/// 磁盘上把 from 改名为 to（不动 index）。
fn rename_on_disk(repo: &git2::Repository, from: &str, to: &str) {
    let workdir = repo.workdir().expect("仓库应有工作区");
    std::fs::rename(workdir.join(from), workdir.join(to)).expect("磁盘改名失败");
}

/// 把 to 的当前内容加入 index 并移除 from 的旧条目（git mv 的 index 效果），
/// 返回改名提交（含磁盘改名）后的新提交 id。
fn commit_rename(repo: &git2::Repository, from: &str, to: &str, message: &str) -> String {
    let mut index = repo.index().expect("读取 index 失败");
    index.remove_path(Path::new(from)).expect("移除旧路径失败");
    index.add_path(Path::new(to)).expect("加入新路径失败");
    index.write().expect("写回 index 失败");
    let tree_oid = index.write_tree_to(repo).expect("write_tree 失败");
    let tree = repo.find_tree(tree_oid).expect("find_tree 失败");
    let parents: Vec<git2::Commit<'_>> = vec![
        repo.head()
            .expect("读取 HEAD 失败")
            .peel_to_commit()
            .expect("解析 HEAD 失败"),
    ];
    let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig(), &sig(), message, &tree, &parent_refs)
        .expect("创建提交失败");
    oid.to_string()
}

/// (7) 重命名提交：changed_files 按新路径上报，file_diff_commit（新路径查询）
/// 返回配对后的 Renamed diff，而非整文件 Added。
#[test]
fn file_diff_commit_renamed() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "line1\nline2\nline3\n", "initial");

    // git mv a.txt b.txt 且顺手改一行。
    rename_on_disk(&repo, "a.txt", "b.txt");
    std::fs::write(
        repo.workdir().expect("工作区").join("b.txt"),
        "line1\nchanged\nline3\n",
    )
    .expect("写入失败");
    let c2 = commit_rename(&repo, "a.txt", "b.txt", "rename");

    let files = changed_files(&repo, &c2).expect("changed_files 失败");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "b.txt");
    assert_eq!(files[0].old_path.as_deref(), Some("a.txt"));
    assert!(matches!(files[0].change_type, ChangeType::Renamed));

    let d = file_diff_commit(&repo, &c2, "b.txt").expect("file_diff_commit 失败");
    assert!(
        matches!(d.change_type, ChangeType::Renamed),
        "应为 Renamed，实际 {:?}",
        d.change_type
    );
    assert_eq!(d.old_path.as_deref(), Some("a.txt"));
    assert_eq!(d.new_path.as_deref(), Some("b.txt"));
    assert_eq!(
        (d.additions, d.deletions),
        (1, 1),
        "仅 line2 → changed 一对增删"
    );

    // 按旧路径查询也应定位到同一配对。
    let d_old = file_diff_commit(&repo, &c2, "a.txt").expect("file_diff_commit(旧路径) 失败");
    assert!(matches!(d_old.change_type, ChangeType::Renamed));
    assert_eq!(d_old.new_path.as_deref(), Some("b.txt"));
}

/// (8) 暂存重命名：status 按旧路径上报（b.txt 并入 rename 条目），
/// file_diff_staged(旧路径) 返回配对后的 Renamed diff。
#[test]
fn file_diff_staged_renamed() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "line1\nline2\nline3\n", "initial");

    rename_on_disk(&repo, "a.txt", "b.txt");
    std::fs::write(
        repo.workdir().expect("工作区").join("b.txt"),
        "line1\nchanged\nline3\n",
    )
    .expect("写入失败");
    let mut index = repo.index().expect("读取 index 失败");
    index
        .remove_path(Path::new("a.txt"))
        .expect("移除旧路径失败");
    index.add_path(Path::new("b.txt")).expect("加入新路径失败");
    index.write().expect("写回 index 失败");

    let statuses = status(&repo).expect("status 失败");
    let entry = find_status(&statuses, "a.txt").expect("a.txt 应按旧路径上报暂存重命名");
    assert!(matches!(entry.staged, Some(ChangeType::Renamed)));

    let d = file_diff_staged(&repo, "a.txt").expect("file_diff_staged 失败");
    assert!(
        matches!(d.change_type, ChangeType::Renamed),
        "应为 Renamed，实际 {:?}",
        d.change_type
    );
    assert_eq!(d.old_path.as_deref(), Some("a.txt"));
    assert_eq!(d.new_path.as_deref(), Some("b.txt"));
    assert_eq!(
        (d.additions, d.deletions),
        (1, 1),
        "HEAD a.txt vs index b.txt 仅一对增删"
    );
}

/// (9) 未暂存重命名：status 按旧路径上报，file_diff_workdir(旧路径)
/// 返回配对后的 Renamed diff（新侧取工作区新路径内容）。
#[test]
fn file_diff_workdir_renamed() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "line1\nline2\nline3\n", "initial");

    rename_on_disk(&repo, "a.txt", "b.txt");
    std::fs::write(
        repo.workdir().expect("工作区").join("b.txt"),
        "line1\nchanged\nline3\n",
    )
    .expect("写入失败");

    let statuses = status(&repo).expect("status 失败");
    let entry = find_status(&statuses, "a.txt").expect("a.txt 应按旧路径上报未暂存重命名");
    assert!(matches!(entry.unstaged, Some(ChangeType::Renamed)));

    let d = file_diff_workdir(&repo, "a.txt").expect("file_diff_workdir 失败");
    assert!(
        matches!(d.change_type, ChangeType::Renamed),
        "应为 Renamed，实际 {:?}",
        d.change_type
    );
    assert_eq!(d.old_path.as_deref(), Some("a.txt"));
    assert_eq!(d.new_path.as_deref(), Some("b.txt"));
    assert_eq!(
        (d.additions, d.deletions),
        (1, 1),
        "index a.txt vs 工作区 b.txt 仅一对增删"
    );
}

/// (10) 工作区普通场景回归（修改 / untracked / 删除 / 干净文件）。
#[test]
fn file_diff_workdir_plain_cases() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "v1\n", "initial");

    // 修改。
    std::fs::write(repo.workdir().expect("工作区").join("a.txt"), "v2\n").expect("写入失败");
    let d = file_diff_workdir(&repo, "a.txt").expect("modified diff 失败");
    assert!(matches!(d.change_type, ChangeType::Modified));
    assert_eq!((d.additions, d.deletions), (1, 1));
    assert_eq!(d.old_path.as_deref(), Some("a.txt"));
    assert_eq!(d.new_path.as_deref(), Some("a.txt"));

    // untracked：整体 Added。
    std::fs::write(repo.workdir().expect("工作区").join("new.txt"), "n\n").expect("写入失败");
    let d = file_diff_workdir(&repo, "new.txt").expect("untracked diff 失败");
    assert!(matches!(d.change_type, ChangeType::Added));
    assert_eq!((d.additions, d.deletions), (1, 0));

    // 删除。
    std::fs::remove_file(repo.workdir().expect("工作区").join("a.txt")).expect("删除失败");
    let d = file_diff_workdir(&repo, "a.txt").expect("deleted diff 失败");
    assert!(matches!(d.change_type, ChangeType::Deleted));
    assert_eq!((d.additions, d.deletions), (0, 1));

    // 干净文件：无工作区变更，返回无增删的 Modified diff。
    let (_dir2, repo2) = init_repo();
    commit_file(&repo2, "a.txt", "v1\n", "initial");
    let d = file_diff_workdir(&repo2, "a.txt").expect("clean diff 失败");
    assert!(matches!(d.change_type, ChangeType::Modified));
    assert_eq!((d.additions, d.deletions), (0, 0));
}

/// 配置名为 origin 的远程（指向占位 URL；libgit2 解析上游时校验
/// remote 存在），并把 workdir 文件写入远程跟踪引用
/// origin/<branch>（模拟 fetch 结果）。
fn create_remote_ref(repo: &git2::Repository, branch: &str, commit_id: &str) {
    if repo.find_remote("origin").is_err() {
        repo.remote("origin", "https://example.com/openpatchline-test.git")
            .expect("配置 origin 远程失败");
    }
    let oid = git2::Oid::from_str(commit_id).expect("commit id 非法");
    repo.reference(&format!("refs/remotes/origin/{branch}"), oid, true, "test")
        .expect("创建远程跟踪引用失败");
}

/// 为本地分支配置上游（branch.<name>.remote / .merge）。
fn set_upstream_config(repo: &git2::Repository, branch: &str) {
    let mut config = repo.config().expect("读取仓库配置失败");
    config
        .set_str(&format!("branch.{branch}.remote"), "origin")
        .expect("设置 remote 失败");
    config
        .set_str(
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{branch}"),
        )
        .expect("设置 merge 失败");
}

/// (11) list_branches：本地在前、当前分支标记、上游与 ahead/behind、
/// 远程分支列出且跳过 origin/HEAD 符号引用。
#[test]
fn list_branches_current_upstream_and_remote() {
    let (_dir, repo) = init_repo();
    let c1 = commit_file(&repo, "a.txt", "v1\n", "initial");
    let main = repo
        .head()
        .expect("读取 HEAD 失败")
        .shorthand()
        .expect("HEAD 应为分支")
        .to_string();

    // dev 分支停在 c1；主线继续前进 → main 领先 dev。
    let tip = repo
        .find_commit(git2::Oid::from_str(&c1).expect("oid 非法"))
        .expect("查找提交失败");
    repo.branch("dev", &tip, false).expect("创建 dev 失败");
    let c2 = commit_file(&repo, "a.txt", "v2\n", "second");

    // 上游 origin/main 指向 c1（落后 1、领先 0）。
    create_remote_ref(&repo, &main, &c1);
    set_upstream_config(&repo, &main);
    // origin/HEAD 符号引用应被跳过。
    repo.reference_symbolic(
        "refs/remotes/origin/HEAD",
        &format!("refs/remotes/origin/{main}"),
        true,
        "test",
    )
    .expect("创建 origin/HEAD 失败");

    let branches = list_branches(&repo).expect("list_branches 失败");
    let names: Vec<(&str, BranchKind)> =
        branches.iter().map(|b| (b.name.as_str(), b.kind)).collect();
    // dev / main 本地在前（字典序），origin/main 远程在后。
    assert_eq!(
        names,
        vec![
            ("dev", BranchKind::Local),
            (main.as_str(), BranchKind::Local),
            (format!("origin/{main}").as_str(), BranchKind::Remote),
        ],
        "本地在前远程在后，origin/HEAD 符号引用跳过"
    );

    let main_info = branches
        .iter()
        .find(|b| b.name == main)
        .expect("应包含当前分支");
    assert!(main_info.is_current);
    assert_eq!(
        main_info.upstream.as_deref(),
        Some(format!("origin/{main}").as_str())
    );
    assert_eq!((main_info.ahead, main_info.behind), (Some(1), Some(0)));
    assert_eq!(main_info.tip_commit, c2);

    let dev_info = branches
        .iter()
        .find(|b| b.name == "dev")
        .expect("应包含 dev");
    assert!(!dev_info.is_current);
    assert_eq!(dev_info.upstream, None, "dev 未配置上游");
    assert_eq!(dev_info.tip_commit, c1);
}

/// 空仓库：无分支可列。
#[test]
fn list_branches_empty_repo() {
    let (_dir, repo) = init_repo();
    let branches = list_branches(&repo).expect("list_branches 失败");
    assert!(branches.is_empty(), "unborn HEAD 时分支列表应为空");
}

/// (12) checkout：本地分支往返切换，工作区内容与 head_branch 跟随。
#[test]
fn checkout_switches_local_branches() {
    let (_dir, mut repo) = init_repo();
    commit_file(&repo, "a.txt", "v1\n", "initial");
    let main = repo
        .head()
        .expect("读取 HEAD 失败")
        .shorthand()
        .expect("HEAD 应为分支")
        .to_string();
    {
        // dev 分支停在当前 tip（块作用域及时释放对 repo 的借用）。
        let tip = repo
            .head()
            .expect("读取 HEAD 失败")
            .peel_to_commit()
            .expect("解析 HEAD 失败");
        repo.branch("dev", &tip, false).expect("创建 dev 失败");
    }

    // 切到 dev 并提交不同内容。
    checkout_branch(&mut repo, "dev").expect("切换到 dev 失败");
    let c2 = commit_file(&repo, "a.txt", "v2\n", "on dev");
    assert_eq!(
        repo_info(&repo)
            .expect("repo_info 失败")
            .head_branch
            .as_deref(),
        Some("dev")
    );

    // 切回主线：内容回到 v1；再切 dev：内容 v2。
    checkout_branch(&mut repo, &main).expect("切回主线失败");
    assert_eq!(read_workdir(&repo, "a.txt"), "v1\n");
    checkout_branch(&mut repo, "dev").expect("再切 dev 失败");
    assert_eq!(read_workdir(&repo, "a.txt"), "v2\n");
    let info = repo_info(&repo).expect("repo_info 失败");
    assert_eq!(info.head_branch.as_deref(), Some("dev"));
    assert_eq!(info.head_commit, c2);
}

/// 读取 workdir 文件内容（测试辅助）。
fn read_workdir(repo: &git2::Repository, path: &str) -> String {
    std::fs::read_to_string(repo.workdir().expect("应有工作区").join(path)).expect("读取文件失败")
}

/// (13) checkout 安全性：会被覆盖的未提交修改报错；不冲突的修改保留。
#[test]
fn checkout_rejects_conflicting_local_changes() {
    let (_dir, mut repo) = init_repo();
    commit_file(&repo, "a.txt", "v1\n", "initial");
    let main = repo
        .head()
        .expect("读取 HEAD 失败")
        .shorthand()
        .expect("HEAD 应为分支")
        .to_string();
    {
        let tip = repo
            .head()
            .expect("读取 HEAD 失败")
            .peel_to_commit()
            .expect("解析 HEAD 失败");
        repo.branch("dev", &tip, false).expect("创建 dev 失败");
    }

    // dev 上 a.txt 改为 v2。
    checkout_branch(&mut repo, "dev").expect("切换到 dev 失败");
    commit_file(&repo, "a.txt", "v2\n", "on dev");
    checkout_branch(&mut repo, &main).expect("切回主线失败");

    // 未提交修改 a.txt（与 dev 冲突）→ 切换失败且留在原分支。
    std::fs::write(repo.workdir().expect("应有工作区").join("a.txt"), "dirty\n").expect("写入失败");
    match checkout_branch(&mut repo, "dev") {
        Err(AppError::Git(_)) => {}
        Err(e) => panic!("期望 Git 错误，实际 {e:?}"),
        Ok(()) => panic!("有冲突的未提交修改时不应切换成功"),
    }
    assert_eq!(
        repo_info(&repo)
            .expect("repo_info 失败")
            .head_branch
            .as_deref(),
        Some(main.as_str()),
        "失败的切换不应移动 HEAD"
    );

    // 丢弃脏改（恢复 v1），新增不冲突的 untracked 文件后切换成功且文件保留。
    std::fs::write(repo.workdir().expect("应有工作区").join("a.txt"), "v1\n").expect("恢复失败");
    std::fs::write(
        repo.workdir().expect("应有工作区").join("note.md"),
        "note\n",
    )
    .expect("写入失败");
    checkout_branch(&mut repo, "dev").expect("不冲突修改不应阻断切换");
    assert_eq!(read_workdir(&repo, "a.txt"), "v2\n");
    assert_eq!(
        read_workdir(&repo, "note.md"),
        "note\n",
        "untracked 文件应保留"
    );
}

/// (14) checkout 远程分支：创建同名本地跟踪分支（DWIM），二次点击
/// 远程名时切换到既有本地分支。
#[test]
fn checkout_remote_creates_tracking_branch() {
    let (_dir, mut repo) = init_repo();
    let c1 = commit_file(&repo, "a.txt", "v1\n", "initial");

    // 模拟 fetch：origin/feat 指向 c1。
    create_remote_ref(&repo, "feat", &c1);

    checkout_branch(&mut repo, "origin/feat").expect("检出远程分支失败");
    let info = repo_info(&repo).expect("repo_info 失败");
    assert_eq!(
        info.head_branch.as_deref(),
        Some("feat"),
        "应创建并切到本地 feat"
    );
    assert_eq!(info.head_commit, c1);

    // 本地 feat 的上游应配置为 origin/feat。
    let upstream_name = {
        let local = repo
            .find_branch("feat", git2::BranchType::Local)
            .expect("本地 feat 应存在");
        let upstream = local.upstream().expect("上游应已配置");
        upstream.name().expect("上游名非法").map(str::to_string)
    };
    assert_eq!(upstream_name.as_deref(), Some("origin/feat"));

    // 再次按远程名检出：本地已存在 → 直接切换本地 feat，不报错。
    checkout_branch(&mut repo, "origin/feat").expect("二次检出远程分支失败");
    assert_eq!(
        repo_info(&repo)
            .expect("repo_info 失败")
            .head_branch
            .as_deref(),
        Some("feat")
    );
}

/// (15) checkout 参数校验：空名 / 非法名 / 不存在的分支。
#[test]
fn checkout_invalid_and_unknown_branch() {
    let (_dir, mut repo) = init_repo();
    commit_file(&repo, "a.txt", "v1\n", "initial");

    match checkout_branch(&mut repo, "  ") {
        Err(AppError::InvalidArg(_)) => {}
        other => panic!("空分支名应报 InvalidArg，实际 {other:?}"),
    }
    match checkout_branch(&mut repo, "bad..name") {
        Err(AppError::InvalidArg(_)) => {}
        other => panic!("非法分支名应报 InvalidArg，实际 {other:?}"),
    }
    match checkout_branch(&mut repo, "no-such-branch") {
        Err(AppError::NotFound(_)) => {}
        other => panic!("不存在分支应报 NotFound，实际 {other:?}"),
    }
}

/// (16) 含 `/` 的远程名：按最长前缀匹配拆分（my/remote/dev →
/// 远程 `my/remote` + 本地 `dev`），且优先于短名远程 `my` 命中。
#[test]
fn checkout_slash_remote_longest_prefix_match() {
    let (_dir, mut repo) = init_repo();
    let c1 = commit_file(&repo, "a.txt", "v1\n", "initial");

    // 同时配置 my 与 my/remote 两个远程，制造前缀歧义。
    repo.remote("my", "https://example.com/my.git")
        .expect("配置 my 失败");
    repo.remote("my/remote", "https://example.com/my-remote.git")
        .expect("配置 my/remote 失败");
    let oid = git2::Oid::from_str(&c1).expect("oid 非法");
    repo.reference("refs/remotes/my/remote/dev", oid, true, "test")
        .expect("创建远程跟踪引用失败");

    checkout_branch(&mut repo, "my/remote/dev").expect("检出含斜杠远程分支失败");
    let info = repo_info(&repo).expect("repo_info 失败");
    assert_eq!(info.head_branch.as_deref(), Some("dev"), "本地短名应为 dev");

    // 跟踪配置指向完整远程名 my/remote（而非歧义的 my）。
    // libgit2 限制：live config 对象不能直接 get_str，经 snapshot 读取。
    let config = repo
        .config()
        .expect("读取配置失败")
        .snapshot()
        .expect("创建配置快照失败");
    assert_eq!(
        config
            .get_str("branch.dev.remote")
            .expect("remote 应已配置"),
        "my/remote"
    );
    assert_eq!(
        config.get_str("branch.dev.merge").expect("merge 应已配置"),
        "refs/heads/dev"
    );
}

/// 造一个不更新任何引用的提交（父为当前 HEAD），返回提交 id。
fn make_orphan_commit(repo: &git2::Repository, path: &str, content: &str) -> String {
    let file_path = repo.workdir().expect("应有工作区").join(path);
    std::fs::write(&file_path, content).expect("写入文件失败");
    let mut index = repo.index().expect("读取 index 失败");
    index.add_path(Path::new(path)).expect("add_path 失败");
    index.write().expect("写回 index 失败");
    let tree_oid = index.write_tree_to(repo).expect("write_tree 失败");
    let tree = repo.find_tree(tree_oid).expect("find_tree 失败");
    let parent = repo
        .head()
        .expect("读取 HEAD 失败")
        .peel_to_commit()
        .expect("解析 HEAD 失败");
    let oid = repo
        .commit(None, &sig(), &sig(), "orphan", &tree, &[&parent])
        .expect("创建提交失败");
    // 恢复工作区文件到 HEAD 版本，避免影响后续测试步骤。
    std::fs::write(&file_path, "v1\n").expect("恢复文件失败");
    let mut index = repo.index().expect("读取 index 失败");
    index.add_path(Path::new(path)).expect("恢复 index 失败");
    index.write().expect("写回 index 失败");
    oid.to_string()
}

/// (17) DWIM 失败不残留：检出冲突时不创建本地分支、不写跟踪配置
/// （与 git CLI 行为一致）；恢复后重试能正确建分支切换。
#[test]
fn checkout_dwim_failure_leaves_no_residue() {
    let (_dir, mut repo) = init_repo();
    commit_file(&repo, "a.txt", "v1\n", "initial");
    let head_before = repo
        .head()
        .expect("读取 HEAD 失败")
        .peel_to_commit()
        .expect("解析 HEAD 失败")
        .id()
        .to_string();

    // 远程 dev 分支上 a.txt 内容不同 → 与本地脏改冲突。
    let c2 = make_orphan_commit(&repo, "a.txt", "remote-version\n");
    create_remote_ref(&repo, "dev", &c2);
    std::fs::write(repo.workdir().expect("应有工作区").join("a.txt"), "dirty\n")
        .expect("写入脏改失败");

    match checkout_branch(&mut repo, "origin/dev") {
        Err(AppError::Git(_)) => {}
        Err(e) => panic!("期望 Git 冲突错误，实际 {e:?}"),
        Ok(()) => panic!("冲突的 DWIM 检出不应成功"),
    }
    assert!(
        repo.find_branch("dev", git2::BranchType::Local).is_err(),
        "失败的 DWIM 不应创建本地分支"
    );
    let config = repo.config().expect("读取配置失败");
    assert!(
        config.get_str("branch.dev.remote").is_err(),
        "失败的 DWIM 不应写跟踪配置"
    );
    assert_eq!(
        repo.head()
            .expect("读取 HEAD 失败")
            .peel_to_commit()
            .expect("解析失败")
            .id()
            .to_string(),
        head_before,
        "HEAD 不应移动"
    );

    // 恢复脏改后重试：成功创建跟踪分支并切换（不残留旧状态干扰）。
    std::fs::write(repo.workdir().expect("应有工作区").join("a.txt"), "v1\n").expect("恢复失败");
    checkout_branch(&mut repo, "origin/dev").expect("恢复后 DWIM 应成功");
    assert_eq!(
        repo_info(&repo)
            .expect("repo_info 失败")
            .head_branch
            .as_deref(),
        Some("dev")
    );
    assert_eq!(read_workdir(&repo, "a.txt"), "remote-version\n");
}

#[test]
fn conflicted_status_and_stage_resolution() {
    let (dir, mut repo) = init_repo();
    let base_oid = commit_file(&repo, "a.txt", "base\n", "base");
    let base_commit = repo
        .find_commit(git2::Oid::from_str(&base_oid).unwrap())
        .unwrap();
    let main_branch = repo.head().unwrap().shorthand().unwrap().to_string();

    // 分叉出 topic 分支并修改 a.txt
    repo.branch("topic", &base_commit, false).unwrap();
    drop(base_commit);
    checkout_branch(&mut repo, "topic").unwrap();
    commit_file(&repo, "a.txt", "theirs\n", "topic edit");

    // 切回主分支做冲突修改
    checkout_branch(&mut repo, &main_branch).unwrap();
    commit_file(&repo, "a.txt", "ours\n", "main edit");

    // 用 git CLI 制造真实 merge 冲突（含 MERGE_HEAD 与 stage 1/2/3）
    let out = std::process::Command::new("git")
        .current_dir(dir.path())
        .args(["merge", "topic"])
        .output()
        .unwrap();
    assert!(!out.status.success(), "应当产生合并冲突");

    let info = repo_info(&repo).unwrap();
    assert_eq!(info.state, RepoState::Merging);

    let statuses = status(&repo).unwrap();
    let entry = find_status(&statuses, "a.txt").expect("冲突文件不得被 status 过滤掉");
    assert!(entry.conflicted);
    assert!(entry.staged.is_none());
    assert!(entry.unstaged.is_none());

    // 未解决冲突前禁止直接 create_commit
    assert!(matches!(
        create_commit(&mut repo, "fail"),
        Err(AppError::Git(_))
    ));

    // 手工写入解决结果并 stage_file → 应清除冲突并进入 staged
    std::fs::write(dir.path().join("a.txt"), "resolved\n").unwrap();
    stage_file(&mut repo, "a.txt").unwrap();

    let after_stage = status(&repo).unwrap();
    let entry = find_status(&after_stage, "a.txt").expect("暂存后应在列表");
    assert!(!entry.conflicted);
    assert_eq!(entry.staged, Some(ChangeType::Modified));

    // 测试删除冲突：先用 stage_file 在文件不存在时清理冲突
    let mut idx = repo.index().unwrap();
    let fake = git2::IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        file_size: 0,
        id: repo.blob(b"x").unwrap(),
        flags: (2u16 << 12), // stage 2
        flags_extended: 0,
        path: b"deleted_conflict.txt".to_vec(),
    };
    idx.add(&fake).unwrap();
    idx.write().unwrap();
    stage_file(&mut repo, "deleted_conflict.txt").unwrap();
    assert!(
        !repo.index().unwrap().has_conflicts(),
        "文件删除时 stage_file 也应清除冲突条目"
    );
}
