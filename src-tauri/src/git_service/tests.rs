use super::*;
use crate::types::{
    BranchKind, DiffLineSelection, DiffPatchAction, DiffScope, DiffScopeKind, FileStatus, LineKind,
    PatchSide, RebaseAction, RebasePlanEntry, RefKind, SignatureStatus,
};

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

/// (2) 提交上的引用标签包含 Head（且当前分支不再重复挂载同名的 Local 标签）。
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
        !labels
            .iter()
            .any(|l| l.name == branch_name && matches!(l.kind, RefKind::Local)),
        "当前 HEAD 指向的分支不应同时展示 Head 与 Local 两个同名徽章"
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
    let result = file_diff_commit(&repo, &c2, "a.txt", false).expect("file_diff_commit 失败");
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

    let d = file_diff_commit(&repo, &c2, "b.txt", false).expect("file_diff_commit 失败");
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
    let d_old = file_diff_commit(&repo, &c2, "a.txt", false).expect("file_diff_commit(旧路径) 失败");
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

    let d = file_diff_staged(&repo, "a.txt", false).expect("file_diff_staged 失败");
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

    let d = file_diff_workdir(&repo, "a.txt", false).expect("file_diff_workdir 失败");
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
    let d = file_diff_workdir(&repo, "a.txt", false).expect("modified diff 失败");
    assert!(matches!(d.change_type, ChangeType::Modified));
    assert_eq!((d.additions, d.deletions), (1, 1));
    assert_eq!(d.old_path.as_deref(), Some("a.txt"));
    assert_eq!(d.new_path.as_deref(), Some("a.txt"));

    // untracked：整体 Added。
    std::fs::write(repo.workdir().expect("工作区").join("new.txt"), "n\n").expect("写入失败");
    let d = file_diff_workdir(&repo, "new.txt", false).expect("untracked diff 失败");
    assert!(matches!(d.change_type, ChangeType::Added));
    assert_eq!((d.additions, d.deletions), (1, 0));

    // 删除。
    std::fs::remove_file(repo.workdir().expect("工作区").join("a.txt")).expect("删除失败");
    let d = file_diff_workdir(&repo, "a.txt", false).expect("deleted diff 失败");
    assert!(matches!(d.change_type, ChangeType::Deleted));
    assert_eq!((d.additions, d.deletions), (0, 1));

    // 干净文件：无工作区变更，返回无增删的 Modified diff。
    let (_dir2, repo2) = init_repo();
    commit_file(&repo2, "a.txt", "v1\n", "initial");
    let d = file_diff_workdir(&repo2, "a.txt", false).expect("clean diff 失败");
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

fn workdir_scope() -> DiffScope {
    DiffScope {
        kind: DiffScopeKind::Workdir,
        commit_id: None,
        base_ref: None,
        target_ref: None,
        stash_index: None,
    }
}

fn staged_scope() -> DiffScope {
    DiffScope {
        kind: DiffScopeKind::Staged,
        commit_id: None,
        base_ref: None,
        target_ref: None,
        stash_index: None,
    }
}

fn index_blob_text(repo: &git2::Repository, path: &str) -> Option<String> {
    let idx = fresh_index(repo).unwrap();
    let entry = idx.get_path(Path::new(path), 0)?;
    let blob = repo.find_blob(entry.id).ok()?;
    Some(String::from_utf8_lossy(blob.content()).into_owned())
}

/// 4.1 & 4.2：工作区两个 hunk 独立 stage / unstage / discard + 单行精选（部分增删保留）。
#[test]
fn partial_hunk_and_line_stage_unstage_discard() {
    let (dir, mut repo) = init_repo();
    let base: String = (1..=12).map(|i| format!("line{i}\n")).collect();
    commit_file(&repo, "sample.txt", &base, "init");

    // 分别修改第 2 行与第 10-11 行（形成两处独立 hunk）。
    let edited = "line1\nline2_mod\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10_a\nline10_b\nline12\n";
    std::fs::write(dir.path().join("sample.txt"), edited).unwrap();

    let w_diff = file_diff_workdir(&repo, "sample.txt", false).unwrap();
    let h1_idx = *w_diff.change_row_indices.first().unwrap();
    assert_eq!(h1_idx, 1);

    // 1) 仅暂存第 1 个 hunk（第 2 行）
    apply_diff_selection(
        &mut repo,
        &workdir_scope(),
        "sample.txt",
        DiffPatchAction::Stage,
        &[DiffLineSelection {
            row_index: h1_idx,
            side: PatchSide::Both,
        }],
    false,
    )
    .unwrap();

    let staged_text = index_blob_text(&repo, "sample.txt").unwrap();
    assert!(staged_text.contains("line2_mod\n"));
    assert!(staged_text.contains("line10\nline11\n"));
    assert!(!staged_text.contains("line10_a\n"));

    // 2) 在剩余 workdir diff 中，只选中第 10_b 行的 Added 侧（行级精选），不暂存 10_a 与删除的 line10/11
    let w_diff2 = file_diff_workdir(&repo, "sample.txt", false).unwrap();
    let row_10b = w_diff2
        .rows
        .iter()
        .position(|r| r.right.as_ref().is_some_and(|c| c.content == "line10_b"))
        .unwrap();
    apply_diff_selection(
        &mut repo,
        &workdir_scope(),
        "sample.txt",
        DiffPatchAction::Stage,
        &[DiffLineSelection {
            row_index: row_10b,
            side: PatchSide::New,
        }],
    false,
    )
    .unwrap();

    let staged_after_line = index_blob_text(&repo, "sample.txt").unwrap();
    assert!(staged_after_line.contains("line10\nline11\nline10_b\n"));
    assert!(!staged_after_line.contains("line10_a\n"));

    // 3) 在暂存区中取消暂存第 1 处修改（line2 -> line2_mod）
    let s_diff = file_diff_staged(&repo, "sample.txt", false).unwrap();
    apply_diff_selection(
        &mut repo,
        &staged_scope(),
        "sample.txt",
        DiffPatchAction::Unstage,
        &[DiffLineSelection {
            row_index: 1,
            side: PatchSide::Both,
        }],
    false,
    )
    .unwrap();
    let staged_after_unstage = index_blob_text(&repo, "sample.txt").unwrap();
    assert!(staged_after_unstage.contains("line1\nline2\nline3\n"));
    assert!(staged_after_unstage.contains("line10_b\n"));
    assert_eq!(s_diff.rows[1].left.as_ref().unwrap().content, "line2");

    // 4) 在 workdir 中丢弃 line2_mod 的更改，保留其他修改
    let w_diff3 = file_diff_workdir(&repo, "sample.txt", false).unwrap();
    let row_l2 = w_diff3
        .rows
        .iter()
        .position(|r| r.right.as_ref().is_some_and(|c| c.content == "line2_mod"))
        .unwrap();
    apply_diff_selection(
        &mut repo,
        &workdir_scope(),
        "sample.txt",
        DiffPatchAction::Discard,
        &[DiffLineSelection {
            row_index: row_l2,
            side: PatchSide::Both,
        }],
    false,
    )
    .unwrap();
    let disk_after_discard = std::fs::read_to_string(dir.path().join("sample.txt")).unwrap();
    assert!(disk_after_discard.contains("line1\nline2\nline3\n"));
    assert!(disk_after_discard.contains("line10_a\nline10_b\n"));
}

/// 4.2 边界：CRLF、无 EOF 换行符、未跟踪文件局部暂存/丢弃、重命名文件局部暂存、冲突/越界拒止。
#[test]
fn partial_patch_handles_crlf_eof_newline_untracked_and_rename() {
    let (dir, mut repo) = init_repo();

    // 1) CRLF 保留测试（屏蔽本机全局 core.autocrlf 对 commit_file 写入基准的转换）
    repo.config()
        .unwrap()
        .set_bool("core.autocrlf", false)
        .unwrap();
    commit_file(&repo, "crlf.txt", "a\r\nb\r\nc\r\n", "crlf init");
    std::fs::write(dir.path().join("crlf.txt"), "a\r\nb2\r\nc\r\n").unwrap();
    let diff_crlf = file_diff_workdir(&repo, "crlf.txt", false).unwrap();
    apply_diff_selection(
        &mut repo,
        &workdir_scope(),
        "crlf.txt",
        DiffPatchAction::Stage,
        &[DiffLineSelection {
            row_index: diff_crlf.change_row_indices[0],
            side: PatchSide::Both,
        }],
    false,
    )
    .unwrap();
    assert_eq!(
        index_blob_text(&repo, "crlf.txt").as_deref(),
        Some("a\r\nb2\r\nc\r\n")
    );

    // 2) 无 EOF 换行符（去掉再恢复）
    commit_file(&repo, "noeol.txt", "hello\nworld", "noeol init");
    std::fs::write(dir.path().join("noeol.txt"), "hello\nworld\n").unwrap();
    let diff_nl = file_diff_workdir(&repo, "noeol.txt", false).unwrap();
    apply_diff_selection(
        &mut repo,
        &workdir_scope(),
        "noeol.txt",
        DiffPatchAction::Stage,
        &[DiffLineSelection {
            row_index: diff_nl.change_row_indices[0],
            side: PatchSide::Both,
        }],
    false,
    )
    .unwrap();
    assert_eq!(
        index_blob_text(&repo, "noeol.txt").as_deref(),
        Some("hello\nworld\n")
    );
    let s_nl = file_diff_staged(&repo, "noeol.txt", false).unwrap();
    apply_diff_selection(
        &mut repo,
        &staged_scope(),
        "noeol.txt",
        DiffPatchAction::Unstage,
        &[DiffLineSelection {
            row_index: s_nl.change_row_indices[0],
            side: PatchSide::Both,
        }],
    false,
    )
    .unwrap();
    assert_eq!(
        index_blob_text(&repo, "noeol.txt").as_deref(),
        Some("hello\nworld")
    );

    // 3) 未跟踪文件行级暂存 + 行级丢弃 + 整文件丢弃
    std::fs::write(dir.path().join("new_file.txt"), "first\nsecond\n").unwrap();
    apply_diff_selection(
        &mut repo,
        &workdir_scope(),
        "new_file.txt",
        DiffPatchAction::Stage,
        &[DiffLineSelection {
            row_index: 1,
            side: PatchSide::New,
        }],
    false,
    )
    .unwrap();
    assert_eq!(
        index_blob_text(&repo, "new_file.txt").as_deref(),
        Some("second\n")
    );

    let st = status(&repo).unwrap();
    let nf = find_status(&st, "new_file.txt").unwrap();
    assert_eq!(nf.staged, Some(ChangeType::Added));
    assert_eq!(nf.unstaged, Some(ChangeType::Modified));

    // 只丢弃未跟踪新增文件的 first 行
    let nf_diff = file_diff_workdir(&repo, "new_file.txt", false).unwrap();
    let row_first = nf_diff
        .rows
        .iter()
        .position(|r| r.right.as_ref().is_some_and(|c| c.content == "first"))
        .unwrap();
    apply_diff_selection(
        &mut repo,
        &workdir_scope(),
        "new_file.txt",
        DiffPatchAction::Discard,
        &[DiffLineSelection {
            row_index: row_first,
            side: PatchSide::New,
        }],
    false,
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("new_file.txt")).unwrap(),
        "second\n"
    );

    // 4) 工作区重命名后局部暂存其中一处改动
    let orig: String = (1..=10).map(|i| format!("r_line_{i}\n")).collect();
    commit_file(&repo, "old_name.txt", &orig, "before rename");
    std::fs::remove_file(dir.path().join("old_name.txt")).unwrap();
    let renamed_content = orig
        .replace("r_line_2\n", "r_line_2_edit\n")
        .replace("r_line_9\n", "r_line_9_edit\n");
    std::fs::write(dir.path().join("new_name.txt"), &renamed_content).unwrap();

    let ren_diff = file_diff_workdir(&repo, "new_name.txt", false).unwrap();
    assert_eq!(ren_diff.change_type, ChangeType::Renamed);
    let r2_row = ren_diff.change_row_indices[0];
    apply_diff_selection(
        &mut repo,
        &workdir_scope(),
        "new_name.txt",
        DiffPatchAction::Stage,
        &[DiffLineSelection {
            row_index: r2_row,
            side: PatchSide::Both,
        }],
    false,
    )
    .unwrap();
    assert!(index_blob_text(&repo, "old_name.txt").is_none());
    let staged_ren = index_blob_text(&repo, "new_name.txt").unwrap();
    assert!(staged_ren.contains("r_line_2_edit\n"));
    assert!(staged_ren.contains("r_line_9\n"));
    assert!(!staged_ren.contains("r_line_9_edit\n"));

    // 5) 只读 Commit scope 或越界行下标均被拒绝
    assert!(
        apply_diff_selection(
            &mut repo,
            &DiffScope {
                kind: DiffScopeKind::Commit,
                commit_id: Some("HEAD".into()),
                base_ref: None,
                target_ref: None,
                stash_index: None,
            },
            "new_name.txt",
            DiffPatchAction::Stage,
            &[DiffLineSelection {
                row_index: 0,
                side: PatchSide::Both,
            }],
        false,
        )
        .is_err()
    );
    assert!(
        apply_diff_selection(
            &mut repo,
            &workdir_scope(),
            "new_name.txt",
            DiffPatchAction::Stage,
            &[DiffLineSelection {
                row_index: 9999,
                side: PatchSide::Both,
            }],
        false,
        )
        .is_err()
    );
}

/// 4.3：范围对比 changed_files_range / file_diff_range 支持提交哈希与分支名及重命名识别。
#[test]
fn range_diff_commits_and_branches() {
    let (_dir, repo) = init_repo();
    let c1 = commit_file(&repo, "a.txt", "one\n", "c1");
    let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature", &head_commit, false).unwrap();
    drop(head_commit);

    let c2 = commit_file(&repo, "a.txt", "one\ntwo\n", "c2");
    commit_file(&repo, "b.txt", "hello\n", "c3");

    let range_files = changed_files_range(&repo, &c1, "HEAD").unwrap();
    assert_eq!(range_files.len(), 2);
    assert!(
        range_files
            .iter()
            .any(|f| f.path == "a.txt" && f.additions == 1)
    );
    assert!(
        range_files
            .iter()
            .any(|f| f.path == "b.txt" && f.change_type == ChangeType::Added)
    );

    let diff_b = file_diff_range(&repo, "feature", "HEAD", "b.txt", false).unwrap();
    assert_eq!(diff_b.change_type, ChangeType::Added);
    assert_eq!(diff_b.additions, 1);

    let diff_a = file_diff_range(&repo, &c1, &c2, "a.txt", false).unwrap();
    assert_eq!(diff_a.additions, 1);
    assert!(changed_files_range(&repo, "", "HEAD").is_err());
    assert!(changed_files_range(&repo, "no_such_branch", "HEAD").is_err());
}

/// 4.4：提交模板剥离注释、签名配置解析与历史提交签名校验。
#[test]
fn commit_metadata_template_and_signature_parsing() {
    let (dir, repo) = init_repo();
    let tpl_path = dir.path().join(".gitmessage");
    std::fs::write(
        &tpl_path,
        "# 标题前缀提示\nfeat: \n\n# 详细说明\n\nSigned-off-by: demo\n",
    )
    .unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("commit.template", ".gitmessage").unwrap();
    cfg.set_bool("commit.gpgsign", true).unwrap();
    cfg.set_str("gpg.format", "ssh").unwrap();
    cfg.set_str("user.signingkey", "~/.ssh/id_ed25519.pub")
        .unwrap();

    let meta = commit_metadata(&repo).unwrap();
    assert!(meta.gpg_sign_enabled);
    assert_eq!(meta.gpg_format, "ssh");
    assert_eq!(meta.signing_key.as_deref(), Some("~/.ssh/id_ed25519.pub"));
    assert_eq!(
        meta.commit_template.as_deref(),
        Some("feat: \n\n\nSigned-off-by: demo")
    );

    let c1 = commit_file(&repo, "sig.txt", "data\n", "unsigned commit");
    let sig_info = commit_signature_info(&repo, &c1).unwrap();
    assert_eq!(sig_info.status, SignatureStatus::Unsigned);

    // 校验各种 %G? 输出码解析
    let g = commit::parse_signature_output(&c1, true, "G\tAlice <a@b>\tKEY123\n");
    assert_eq!(g.status, SignatureStatus::Verified);
    assert_eq!(g.signer.as_deref(), Some("Alice <a@b>"));
    assert_eq!(g.key_id.as_deref(), Some("KEY123"));

    let u = commit::parse_signature_output(&c1, true, "U\tBob\tKEY456\n");
    assert_eq!(u.status, SignatureStatus::Untrusted);

    let b = commit::parse_signature_output(&c1, true, "B\t\t\n");
    assert_eq!(b.status, SignatureStatus::Bad);

    let e = commit::parse_signature_output(&c1, true, "E\t\tKEY789\n");
    assert_eq!(e.status, SignatureStatus::Unverifiable);
}

/// 4.5：轻量交互式 rebase（Reword / Squash / Fixup）保留原作者并原子前移分支，合并提交阻断与脏工作区拒止。
#[test]
fn lightweight_rebase_reword_squash_and_guards() {
    let (dir, mut repo) = init_repo();
    let base = commit_file(&repo, "f.txt", "v0\n", "base commit");
    let c1 = commit_file(&repo, "f.txt", "v1\n", "first feat");
    let c2 = commit_file(&repo, "f2.txt", "x\n", "wip fixup");
    let c3 = commit_file(&repo, "f3.txt", "y\n", "squash details");

    let list = list_rebase_commits(&repo, 10).unwrap();
    assert_eq!(list.len(), 4);
    assert_eq!(list[0].id, base);
    assert_eq!(list[3].id, c3);

    // 脏工作区应被拒止
    std::fs::write(dir.path().join("f.txt"), "dirty\n").unwrap();
    let bad_dirty = rewrite_recent_commits(
        &mut repo,
        &[RebasePlanEntry {
            commit_id: c3.clone(),
            action: RebaseAction::Reword,
            message: Some("x".into()),
        }],
    );
    assert!(bad_dirty.is_err());
    std::fs::write(dir.path().join("f.txt"), "v1\n").unwrap();

    // 最早一条设为 Squash 应被拒止
    assert!(
        rewrite_recent_commits(
            &mut repo,
            &[
                RebasePlanEntry {
                    commit_id: c2.clone(),
                    action: RebaseAction::Squash,
                    message: None,
                },
                RebasePlanEntry {
                    commit_id: c3.clone(),
                    action: RebaseAction::Pick,
                    message: None,
                },
            ],
        )
        .is_err()
    );

    // 将 c1 改名为 "feat: rewritten"，c2 Fixup 掉消息，c3 Squash 进同一条提交
    let old_tree_id = repo
        .find_commit(git2::Oid::from_str(&c3).unwrap())
        .unwrap()
        .tree_id();
    let new_head = rewrite_recent_commits(
        &mut repo,
        &[
            RebasePlanEntry {
                commit_id: c1.clone(),
                action: RebaseAction::Reword,
                message: Some("feat: rewritten".into()),
            },
            RebasePlanEntry {
                commit_id: c2.clone(),
                action: RebaseAction::Fixup,
                message: None,
            },
            RebasePlanEntry {
                commit_id: c3.clone(),
                action: RebaseAction::Squash,
                message: None,
            },
        ],
    )
    .unwrap();

    let head_commit = repo
        .find_commit(git2::Oid::from_str(&new_head).unwrap())
        .unwrap();
    assert_eq!(head_commit.tree_id(), old_tree_id);
    assert_eq!(
        head_commit.message().unwrap(),
        "feat: rewritten\n\nsquash details"
    );
    assert_eq!(head_commit.author().name().ok(), Some("Test User"));
    assert_eq!(head_commit.parent_id(0).unwrap().to_string(), base);
    assert_eq!(repo.head().unwrap().target().unwrap(), head_commit.id());
}

#[test]
fn diff_and_stage_reject_path_traversal_and_symlinks() {
    let (_dir, mut repo) = init_repo();
    let outside = tempfile::tempdir().expect("创建外部目录失败");
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "TOP_SECRET_VALUE\n").unwrap();

    commit_file(&repo, "a.txt", "v1\n", "initial");

    // 1) 非法路径 / 越界相对路径一律拦截
    for bad in ["../secret.txt", "/etc/passwd", ".", ""] {
        assert!(
            matches!(file_diff_workdir(&repo, bad, false), Err(AppError::InvalidArg(_))),
            "file_diff_workdir 应拦截 {bad}"
        );
        assert!(
            matches!(stage_file(&mut repo, bad), Err(AppError::InvalidArg(_))),
            "stage_file 应拦截 {bad}"
        );
        assert!(
            matches!(unstage_file(&mut repo, bad), Err(AppError::InvalidArg(_))),
            "unstage_file 应拦截 {bad}"
        );
    }

    // 2) 未变更的未跟踪目录或不存在的文件不再回退去任意读取工作区磁盘
    assert!(matches!(
        file_diff_workdir(&repo, "nonexistent.txt", false),
        Err(AppError::NotFound(_))
    ));

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let workdir = repo.workdir().unwrap().to_path_buf();
        // 目录符号链接指向仓库外：访问 escape_dir/secret.txt 必须被拦截
        symlink(outside.path(), workdir.join("escape_dir")).unwrap();
        assert!(matches!(
            file_diff_workdir(&repo, "escape_dir/secret.txt", false),
            Err(AppError::InvalidArg(_))
        ));
        assert!(matches!(
            stage_file(&mut repo, "escape_dir/secret.txt"),
            Err(AppError::InvalidArg(_))
        ));

        // 文件符号链接指向仓库外：读取工作区 diff 仅呈现符号链接目标字符串，绝不解引用外部文件内容
        symlink(&secret, workdir.join("leak.link")).unwrap();
        let link_diff =
            file_diff_workdir(&repo, "leak.link", false).expect("符号链接 diff 应仅读 link target");
        let joined: String = link_diff
            .rows
            .iter()
            .filter_map(|r| r.right.as_ref())
            .map(|c| c.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !joined.contains("TOP_SECRET_VALUE"),
            "绝不能解引用读取仓库外符号链接目标文件内容"
        );
        assert!(joined.contains(&secret.to_string_lossy().to_string()));
    }
}

#[test]
fn commit_metadata_rejects_local_config_template_outside_workdir() {
    let (_dir, repo) = init_repo();
    let outside = tempfile::tempdir().expect("创建外部目录失败");
    let secret_tpl = outside.path().join("outside_tpl.txt");
    std::fs::write(&secret_tpl, "EXTERNAL_SECRET_TEMPLATE\n").unwrap();

    // 仓库本地 .git/config 指向工作区外文件 → 必须被拦截忽略
    let mut cfg = repo.config().unwrap();
    cfg.set_str("commit.template", secret_tpl.to_str().unwrap())
        .unwrap();
    drop(cfg);
    let meta = commit_metadata(&repo).expect("读取 commit_metadata 失败");
    assert_eq!(meta.commit_template, None);

    // 指向工作区内合法模板文件 → 正常加载
    std::fs::write(
        repo.workdir().unwrap().join(".gitmessage"),
        "feat: tpl\n# comment\n",
    )
    .unwrap();
    let mut cfg2 = repo.config().unwrap();
    cfg2.set_str("commit.template", ".gitmessage").unwrap();
    drop(cfg2);
    let meta2 = commit_metadata(&repo).expect("读取合法模板失败");
    assert_eq!(meta2.commit_template.as_deref(), Some("feat: tpl"));
}

#[test]
fn checkout_remote_rejects_diverged_local_branch() {
    let (_dir, mut repo) = init_repo();
    let c1 = commit_file(&repo, "a.txt", "v1\n", "initial");
    {
        let commit1 = repo.find_commit(git2::Oid::from_str(&c1).unwrap()).unwrap();
        repo.branch("feat", &commit1, false).unwrap();
    }
    let c2 = make_orphan_commit(&repo, "a.txt", "remote\n");
    create_remote_ref(&repo, "feat", &c2);

    // 本地已存在 feat 且与 origin/feat 提交/上游不一致 → 不得静默切错分支
    let res = checkout_branch(&mut repo, "origin/feat");
    assert!(matches!(res, Err(AppError::InvalidArg(_))));
    assert_ne!(
        repo.head().unwrap().shorthand().ok(),
        Some("feat"),
        "拒绝后不应静默切到过时的本地分支 feat"
    );
}

#[test]
fn create_commit_blocked_during_cherry_pick_and_revert() {
    let (dir, mut repo) = init_repo();
    commit_file(&repo, "a.txt", "v1\n", "initial");
    std::fs::write(
        repo.path().join("CHERRY_PICK_HEAD"),
        "0000000000000000000000000000000000000000\n",
    )
    .unwrap();
    assert_eq!(repo_state(&repo), RepoState::CherryPicking);
    assert!(matches!(
        create_commit(&mut repo, "manual commit"),
        Err(AppError::InvalidArg(_))
    ));
    let _ = std::fs::remove_file(dir.path().join(".git/CHERRY_PICK_HEAD"));

    std::fs::write(
        repo.path().join("REVERT_HEAD"),
        "0000000000000000000000000000000000000000\n",
    )
    .unwrap();
    assert_eq!(repo_state(&repo), RepoState::Reverting);
    assert!(matches!(
        create_commit_with_options(&mut repo, "manual commit", Some(false)),
        Err(AppError::InvalidArg(_))
    ));
}

#[test]
fn conflict_detail_and_resolve_roundtrip() {
    let (dir, mut repo) = init_repo();
    let base_oid = commit_file(&repo, "a.txt", "line1\nbase\nline3\n", "base");
    let base_commit = repo
        .find_commit(git2::Oid::from_str(&base_oid).unwrap())
        .unwrap();
    let main_branch = repo.head().unwrap().shorthand().unwrap().to_string();

    repo.branch("topic", &base_commit, false).unwrap();
    drop(base_commit);
    checkout_branch(&mut repo, "topic").unwrap();
    commit_file(&repo, "a.txt", "line1\ntheirs\nline3\n", "topic edit");

    checkout_branch(&mut repo, &main_branch).unwrap();
    commit_file(&repo, "a.txt", "line1\nours\nline3\n", "main edit");

    let out = std::process::Command::new("git")
        .current_dir(dir.path())
        .args(["merge", "topic"])
        .output()
        .unwrap();
    assert!(!out.status.success(), "应当产生合并冲突");

    let detail = get_conflict_file(&repo, "a.txt").expect("读取冲突详情失败");
    assert!(!detail.is_binary);
    assert!(!detail.too_large);
    assert!(detail.base_exists);
    assert!(detail.ours_exists);
    assert!(detail.theirs_exists);
    assert!(detail.workdir_exists);
    assert_eq!(detail.base_content, "line1\nbase\nline3\n");
    assert_eq!(detail.ours_content, "line1\nours\nline3\n");
    assert_eq!(detail.theirs_content, "line1\ntheirs\nline3\n");
    assert!(detail.workdir_content.contains("<<<<<<<"));

    // 非冲突文件应报 NotFound
    assert!(matches!(
        get_conflict_file(&repo, "nonexistent.txt"),
        Err(AppError::NotFound(_))
    ));

    // 先保存但不暂存 → 仍处于冲突状态但工作区已更新
    resolve_conflict_file(&mut repo, "a.txt", "line1\nboth\nline3\n", false, false)
        .expect("仅保存工作区失败");
    let st1 = status(&repo).unwrap();
    assert!(find_status(&st1, "a.txt").unwrap().conflicted);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "line1\nboth\nline3\n"
    );

    // 写入并暂存 → 冲突清除并进入 staged
    resolve_conflict_file(&mut repo, "a.txt", "line1\nfinal\nline3\n", true, false)
        .expect("解决并暂存失败");
    let st2 = status(&repo).unwrap();
    let entry = find_status(&st2, "a.txt").unwrap();
    assert!(!entry.conflicted);
    assert_eq!(entry.staged, Some(ChangeType::Modified));
}

#[test]
fn file_blame_tracks_commits_and_uncommitted_buffer() {
    let (dir, repo) = init_repo();
    let c1 = commit_file(&repo, "notes.txt", "alpha\nbeta\n", "c1: initial");
    let c2 = commit_file(
        &repo,
        "notes.txt",
        "alpha\nbeta-edited\ngamma\n",
        "c2: update",
    );

    // 历史指定提交的 blame
    let b1 = file_blame(&repo, "notes.txt", Some(&c1)).expect("c1 blame 失败");
    assert_eq!(b1.lines.len(), 2);
    assert_eq!(b1.lines[0].commit_id, c1);
    assert_eq!(b1.lines[1].commit_id, c1);
    assert_eq!(b1.lines[0].content, "alpha");

    // c2 应包含 c1（alpha）和 c2（beta-edited, gamma）
    let b2 = file_blame(&repo, "notes.txt", Some(&c2)).expect("c2 blame 失败");
    assert_eq!(b2.lines.len(), 3);
    assert_eq!(b2.lines[0].commit_id, c1);
    assert_eq!(b2.lines[1].commit_id, c2);
    assert_eq!(b2.lines[2].commit_id, c2);
    assert_eq!(b2.commits[&c2].parent_ids, vec![c1.clone()]);

    // 工作区未提交改动应归属到 uncommitted (0000000...)
    std::fs::write(
        dir.path().join("notes.txt"),
        "alpha\nbeta-edited\ngamma\ndirty\n",
    )
    .unwrap();
    let bw = file_blame(&repo, "notes.txt", None).expect("workdir blame 失败");
    assert_eq!(bw.lines.len(), 4);
    assert_eq!(bw.lines[0].commit_id, c1);
    assert_eq!(bw.lines[2].commit_id, c2);
    let dirty_cid = &bw.lines[3].commit_id;
    assert!(bw.commits[dirty_cid].is_uncommitted);
    assert_eq!(bw.lines[3].content, "dirty");

    // 未跟踪文件与越界路径拒绝
    std::fs::write(dir.path().join("untracked.txt"), "hi\n").unwrap();
    assert!(matches!(
        file_blame(&repo, "untracked.txt", None),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        file_blame(&repo, "../secret.txt", None),
        Err(AppError::InvalidArg(_))
    ));
}

#[test]
fn generate_patch_for_workdir_and_staged() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let _c1 = commit_file(&repo, "a.txt", "one\ntwo\nthree\n", "init");

    // 工作区修改 two -> TWO
    std::fs::write(dir.path().join("a.txt"), "one\nTWO\nthree\n").unwrap();
    let patch = generate_file_patch(&repo, &workdir_scope(), "a.txt").expect("生成补丁失败");
    assert!(patch.contains("diff --git a/a.txt b/a.txt"));
    assert!(patch.contains("-two"));
    assert!(patch.contains("+TWO"));

    // 无变更 → NotFound
    std::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
    assert!(matches!(
        generate_file_patch(&repo, &workdir_scope(), "a.txt"),
        Err(AppError::NotFound(_))
    ));

    // 暂存后 staged 范围可生成
    std::fs::write(dir.path().join("a.txt"), "one\nTWO2\nthree\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("a.txt")).unwrap();
    index.write().unwrap();
    let staged = generate_file_patch(&repo, &staged_scope(), "a.txt").expect("staged 补丁失败");
    assert!(staged.contains("+TWO2"));
}

/// v0.7 / 7.1：文件历史跨重命名追踪 + 变更类型正确。
#[test]
fn file_history_follows_rename() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let c1 = commit_file(&repo, "old_name.txt", "one\ntwo\n", "create old");
    // c2: 修改内容（保留路径）
    let c2 = commit_file(&repo, "old_name.txt", "one\ntwo\nthree\n", "edit old");
    // c3: 重命名（内容不变 → rename 检测）
    rename_on_disk(&repo, "old_name.txt", "new_name.txt");
    commit_rename(&repo, "old_name.txt", "new_name.txt", "rename to new");
    // c4: 修改新路径
    let c4 = commit_file(&repo, "new_name.txt", "one\ntwo\nthree\nfour\n", "edit new");

    // 按新路径追溯：应命中 c4、c3(rename)、c2、c1 —— 跨越重命名继续追踪旧路径。
    let hist = file_history(&repo, "new_name.txt", 100).expect("file_history 失败");
    let ids: Vec<&str> = hist.iter().map(|e| e.commit_id.as_str()).collect();
    assert_eq!(ids, vec![c4.as_str(), ids[1], c2.as_str(), c1.as_str()]);
    assert_eq!(hist.len(), 4);
    // 重命名条目：change_type = renamed 且给出旧路径
    let rename_entry = &hist[1];
    assert_eq!(rename_entry.change_type, ChangeType::Renamed);
    assert_eq!(rename_entry.old_path.as_deref(), Some("old_name.txt"));
    assert_eq!(rename_entry.path, "new_name.txt");
    // 其余条目 change_type 正确、old_path = None；c1 为初始创建（Added）
    assert_eq!(hist[0].change_type, ChangeType::Modified);
    assert_eq!(hist[0].old_path, None);
    assert_eq!(hist[2].change_type, ChangeType::Modified);
    assert_eq!(hist[3].change_type, ChangeType::Added);
    // 摘要与作者
    assert_eq!(hist[0].summary, "edit new");

    // 未被任何提交触碰的文件 → 空历史
    let empty = file_history(&repo, "nonexistent.txt", 100).unwrap();
    assert!(empty.is_empty());

    // limit 截断
    let limited = file_history(&repo, "new_name.txt", 2).unwrap();
    assert_eq!(limited.len(), 2);
}

/// review 修复 #3：合并历史（侧分支重命名 a→b）不影响主线 b.txt 的历史。
#[test]
fn file_history_survives_merge_history_with_side_rename() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    // 主线：创建 b.txt 并两次修改
    let c1 = commit_file(&repo, "b.txt", "v1\n", "main: create b");
    let c2 = commit_file(&repo, "b.txt", "v1\nv2\n", "main: edit b");
    let _c3 = commit_file(&repo, "other.txt", "x\n", "main: other");

    // 侧分支：把 a.txt 重命名为 b.txt（与主线 b.txt 无关的另一来源）
    commit_file(&repo, "a.txt", "aaa\n", "main: create a");
    let side_commit0 = repo
        .commit(
            Some("refs/heads/side-src"),
            &sig(),
            &sig(),
            "side base",
            &repo.head().unwrap().peel_to_commit().unwrap().tree().unwrap(),
            &[&repo.head().unwrap().peel_to_commit().unwrap()],
        )
        .unwrap();
    let side_commit0 = repo
        .find_commit(side_commit0)
        .expect("解析侧分支基准提交失败");
    rename_on_disk(&repo, "a.txt", "b.txt");
    {
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new("a.txt")).unwrap();
        index.add_path(Path::new("b.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree_to(&repo).unwrap()).unwrap();
        repo.commit(
            Some("refs/heads/side-src"),
            &sig(),
            &sig(),
            "side: rename a to b",
            &tree,
            &[&side_commit0],
        )
        .unwrap();
    }
    // 回到默认分支（HEAD）并合并 side-src
    let default_branch = repo.head().unwrap().shorthand().unwrap().to_string();
    let main_tip = repo.find_reference(&format!("refs/heads/{default_branch}")).unwrap().peel_to_commit().unwrap();
    std::fs::write(dir.path().join("a.txt"), "aaa merged\n").unwrap();
    std::fs::remove_file(dir.path().join("b.txt")).unwrap();
    // 合并会冲突（两侧都有 b.txt）——改用手工合并树：保留主线 b.txt 内容与 a.txt
    let mut index = repo.index().unwrap();
    index.read_tree(&main_tip.tree().unwrap()).unwrap();
    index.add_path(Path::new("a.txt")).unwrap();
    index.write().unwrap();
    let merge_tree = repo.find_tree(index.write_tree_to(&repo).unwrap()).unwrap();
    repo.commit(
        Some("HEAD"),
        &sig(),
        &sig(),
        "merge side-src",
        &merge_tree,
        &[&main_tip, &side_commit0],
    )
    .unwrap();
    // 主线后续再改 b.txt
    let c5 = commit_file(&repo, "b.txt", "v1\nv2\nv3\n", "main: edit b again");

    // 按 b.txt 追溯：必须包含主线最新提交（自研全 DAG 实现会在此丢提交）
    let hist = file_history(&repo, "b.txt", 100).unwrap();
    let ids: Vec<&str> = hist.iter().map(|e| e.commit_id.as_str()).collect();
    assert!(ids.contains(&c5.as_str()), "主线最新提交丢失: {ids:?}");
    assert!(ids.contains(&c2.as_str()), "主线早期提交丢失: {ids:?}");
    assert!(ids.contains(&c1.as_str()), "主线创建提交丢失: {ids:?}");
}

/// v0.7 / 7.4：stash 变更文件与单文件 diff 与 `git stash show` 口径一致。
#[test]
fn stash_files_and_diff_match_git_show() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let _c1 = commit_file(&repo, "a.txt", "one\ntwo\n", "init");
    // 修改 a.txt 并贮藏（git stash push -u）
    std::fs::write(dir.path().join("a.txt"), "one\nTWO\n").unwrap();
    let out = std::process::Command::new("git")
        .current_dir(dir.path())
        .args(["stash", "push", "-u", "-m", "wip"])
        .output()
        .expect("git stash push 失败");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    let files = changed_files_stash(&repo, 0).expect("changed_files_stash 失败");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "a.txt");
    assert_eq!(files[0].change_type, ChangeType::Modified);

    let diff = file_diff_stash(&repo, 0, "a.txt", false).expect("file_diff_stash 失败");
    assert_eq!(diff.additions, 1);
    assert_eq!(diff.deletions, 1);
    // 右侧应为贮藏后的内容
    let right: Vec<&str> = diff
        .rows
        .iter()
        .filter_map(|r| r.right.as_ref().map(|c| c.content.as_str()))
        .collect();
    assert!(right.contains(&"TWO"));

    // 越界 index → NotFound
    assert!(matches!(
        changed_files_stash(&repo, 5),
        Err(AppError::NotFound(_))
    ));
}

/// review 修复验证：多条贮藏时 stash@{0} 指最新一条；-u 未跟踪文件参与预览。
#[test]
fn stash_preview_indexes_latest_and_includes_untracked() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let _c1 = commit_file(&repo, "base.txt", "v1\n", "init");

    // 先贮藏 A（修改 a.txt），再贮藏 B（修改 b.txt + 未跟踪 new.txt）
    std::fs::write(dir.path().join("a.txt"), "a-stash\n").unwrap();
    let out = std::process::Command::new("git")
        .current_dir(dir.path())
        .args(["stash", "push", "-u", "-m", "stash A"])
        .output()
        .unwrap();
    assert!(out.status.success());

    std::fs::write(dir.path().join("b.txt"), "b-stash\n").unwrap();
    std::fs::write(dir.path().join("new.txt"), "untracked\n").unwrap();
    let out = std::process::Command::new("git")
        .current_dir(dir.path())
        .args(["stash", "push", "-u", "-m", "stash B"])
        .output()
        .unwrap();
    assert!(out.status.success());

    // stash@{0} = 最新（B）：b.txt 修改 + new.txt 未跟踪
    let files = changed_files_stash(&repo, 0).expect("stash@{0} 失败");
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"b.txt"), "stash@{{0}} 应含 b.txt，实际 {paths:?}");
    assert!(paths.contains(&"new.txt"), "-u 未跟踪文件应参与预览");
    assert!(!paths.contains(&"a.txt"), "stash@{{0}} 不应看到最旧的 A");

    // stash@{1} = A：a.txt 修改
    let files1 = changed_files_stash(&repo, 1).expect("stash@{1} 失败");
    let paths1: Vec<&str> = files1.iter().map(|f| f.path.as_str()).collect();
    assert!(paths1.contains(&"a.txt"));
    assert!(!paths1.contains(&"b.txt"));

    // 未跟踪文件单文件 diff 可看
    let diff = file_diff_stash(&repo, 0, "new.txt", false).expect("未跟踪 diff 失败");
    assert_eq!(diff.additions, 1);

    // 只有未跟踪文件的贮藏：不再返回空列表
    std::fs::write(dir.path().join("solo.txt"), "solo\n").unwrap();
    let out = std::process::Command::new("git")
        .current_dir(dir.path())
        .args(["stash", "push", "-u", "-m", "untracked only"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let files2 = changed_files_stash(&repo, 0).expect("untracked-only 贮藏失败");
    assert!(files2.iter().any(|f| f.path == "solo.txt"));
}

/// v0.7 / 7.5：branches_containing 按祖先关系判定（本地 + 远程）。
#[test]
fn branches_containing_by_ancestry() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let c1 = commit_file(&repo, "a.txt", "one\n", "initial");
    let c2 = commit_file(&repo, "a.txt", "one\ntwo\n", "second");
    // 从 c1 拉出 side 分支
    let c1_commit = repo.find_commit(git2::Oid::from_str(&c1).unwrap()).unwrap();
    repo.branch("side", &c1_commit, false).unwrap();

    // 当前分支（HEAD）包含 c1 与 c2；side 只包含 c1。
    let head_name = repo
        .head()
        .unwrap()
        .shorthand()
        .unwrap()
        .to_string();
    let containing_c2 = branches_containing(&repo, &c2).unwrap();
    assert_eq!(containing_c2, vec![head_name]);
    let containing_c1 = branches_containing(&repo, &c1).unwrap();
    assert!(containing_c1.iter().any(|n| n == "side"));
    assert_eq!(containing_c1.len(), 2);
}

/// v0.8 / 8.6 异常场景：浅克隆（shallow）下图分页 / 状态 / diff 均可用。
#[test]
fn edge_case_shallow_clone() {
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = git2::Repository::init_bare(remote_dir.path()).unwrap();
    drop(remote);
    run_cli(remote_dir.path(), &["config", "user.email", "t@t"]);
    // 在裸远程上无法直接提交——本地工作仓库推送后再浅克隆。
    let src_dir = tempfile::tempdir().unwrap();
    let src = git2::Repository::init(src_dir.path()).unwrap();
    {
        let mut cfg = src.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t").unwrap();
    }
    commit_file(&src, "a.txt", "one\n", "c1");
    commit_file(&src, "a.txt", "one\ntwo\n", "c2");
    drop(src);
    run_cli(src_dir.path(), &["remote", "add", "origin", remote_dir.path().to_str().unwrap()]);
    run_cli(src_dir.path(), &["push", "-u", "origin", "HEAD"]);

    // --depth 1 浅克隆
    let clone_root = tempfile::tempdir().unwrap();
    let clone_path = clone_root.path().join("shallow-clone");
    run_cli(
        clone_root.path(),
        &[
            "clone",
            "--depth",
            "1",
            &format!("file://{}", remote_dir.path().display()),
            clone_path.to_str().unwrap(),
        ],
    );
    let clone = git2::Repository::open(&clone_path).unwrap();
    assert!(clone.is_shallow(), "应为浅克隆");

    // 图分页可用（边界提交无父，不越界）
    let (page, more) = load_commit_page(&clone, None, 10, None).unwrap();
    assert_eq!(page.len(), 1, "depth=1 只有一条提交");
    assert!(!more);
    // 状态与工作区 diff 正常
    std::fs::write(clone_path.join("a.txt"), "one\ntwo\ndirty\n").unwrap();
    let statuses = status(&clone).unwrap();
    assert_eq!(statuses.len(), 1);
    let diff = file_diff_workdir(&clone, "a.txt", false).unwrap();
    assert_eq!(diff.additions, 1);
}

/// v0.8 / 8.6 异常场景：非 UTF-8（Latin-1）文件 diff 走 lossy 转换不崩溃。
#[test]
fn edge_case_non_utf8_file() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    // 提交合法 UTF-8 基线
    std::fs::write(dir.path().join("latin.txt"), "caf\u{e9} baseline\n").unwrap();
    {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("latin.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree_to(&repo).unwrap()).unwrap();
        let sig_ = sig();
        repo.commit(Some("HEAD"), &sig_, &sig_, "init", &tree, &[]).unwrap();
    }
    // 工作区写入非法 UTF-8 字节（0xFF 0xFE）
    std::fs::write(dir.path().join("latin.txt"), b"\xff\xfe garbage\n").unwrap();
    let diff = file_diff_workdir(&repo, "latin.txt", false).expect("非 UTF-8 diff 不应崩溃");
    assert!(!diff.is_binary, "无 NUL 字节不应判为二进制");
    assert_eq!(diff.additions, 1);
    // 状态 / 暂存可用
    let mut repo2 = git2::Repository::open(dir.path()).unwrap();
    stage_file(&mut repo2, "latin.txt").unwrap();
}

/// v0.8 / 8.6 异常场景：超长嵌套路径（~300 字符）状态与 diff 可用。
#[test]
fn edge_case_long_nested_path() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let deep: String = (0..20)
        .map(|i| format!("level-{i:02}-segment"))
        .collect::<Vec<_>>()
        .join("/");
    assert!(deep.len() > 300, "路径应足够长，实际 {}", deep.len());
    let full = dir.path().join(&deep);
    std::fs::create_dir_all(&full).unwrap();
    std::fs::write(full.join("leaf.txt"), "deep\n").unwrap();
    {
        let mut index = repo.index().unwrap();
        index
            .add_path(Path::new(&format!("{deep}/leaf.txt")))
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree_to(&repo).unwrap()).unwrap();
        let sig_ = sig();
        repo.commit(Some("HEAD"), &sig_, &sig_, "deep init", &tree, &[]).unwrap();
    }
    let rel = format!("{deep}/leaf.txt");
    std::fs::write(full.join("leaf.txt"), "deep changed\n").unwrap();
    let statuses = status(&repo).unwrap();
    assert_eq!(statuses[0].path, rel);
    let diff = file_diff_workdir(&repo, &rel, false).unwrap();
    assert_eq!(diff.additions, 1);
}

/// v0.8 / 8.6 异常场景：Git LFS 指针文件按普通文本处理（不崩溃、可 diff）。
#[test]
fn edge_case_lfs_pointer_file() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32bfa8d75fb84e0d1b7fba8d7\nsize 12345\n";
    std::fs::write(dir.path().join("asset.bin"), pointer).unwrap();
    {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("asset.bin")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree_to(&repo).unwrap()).unwrap();
        let sig_ = sig();
        repo.commit(Some("HEAD"), &sig_, &sig_, "add lfs pointer", &tree, &[])
            .unwrap();
    }
    std::fs::write(
        dir.path().join("asset.bin"),
        pointer.replace("12345", "99999"),
    )
    .unwrap();
    let diff = file_diff_workdir(&repo, "asset.bin", false).unwrap();
    assert!(!diff.is_binary);
    assert_eq!(diff.additions, 1);
    assert_eq!(diff.deletions, 1);
}

/// 集成测试辅助：跑真实 git CLI（浅克隆等 libgit2 不便构造的场景）。
fn run_cli(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("执行 git 失败");
    assert!(
        out.status.success(),
        "git {:?} 失败: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}
