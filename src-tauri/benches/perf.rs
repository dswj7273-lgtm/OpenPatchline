//! 性能基准（Task 3.5）：10 万提交首屏、图布局分页耗时、5 万行 Diff 耗时。
//!
//! 运行方式：`cargo bench --manifest-path src-tauri/Cargo.toml`
//! 若设置 `GITHUB_STEP_SUMMARY`，同步输出 Markdown 表格到 CI Summary。

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use openpatchline_lib::diff_engine::{self, DiffOptions};
use openpatchline_lib::git_service;
use openpatchline_lib::graph::GraphState;
use openpatchline_lib::repo_manager::{RepoManager, lock_entry};
use openpatchline_lib::types::CommitNode;

/// 使用 `git fast-import` 在临时目录高速构造 `count` 条提交。
fn build_large_repo(count: usize) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("创建临时仓库失败");
    let init_status = Command::new("git")
        .current_dir(dir.path())
        .args(["init", "-q"])
        .status()
        .expect("执行 git init 失败");
    assert!(init_status.success(), "git init 失败");

    let mut child = Command::new("git")
        .current_dir(dir.path())
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .spawn()
        .expect("启动 git fast-import 失败");

    {
        let mut stdin = std::io::BufWriter::new(child.stdin.take().expect("stdin"));
        writeln!(stdin, "blob\nmark :1\ndata 6\nhello\n").unwrap();
        for i in 1..=count {
            let msg = format!("commit #{i}");
            writeln!(
                stdin,
                "commit refs/heads/main\nmark :{mark}\nauthor Bench <bench@example.com> {ts} +0000\ncommitter Bench <bench@example.com> {ts} +0000\ndata {len}\n{msg}",
                mark = i + 1,
                ts = 1_700_000_000 + i,
                len = msg.len(),
            )
            .unwrap();
            if i == 1 {
                writeln!(stdin, "M 100644 :1 README.md").unwrap();
            } else {
                writeln!(stdin, "from :{prev}", prev = i).unwrap();
            }
        }
        writeln!(stdin, "done").unwrap();
    }

    let status = child.wait().expect("等待 fast-import 失败");
    assert!(status.success(), "git fast-import 失败");
    dir
}

fn synthetic_graph_commits(count: usize) -> Vec<CommitNode> {
    (0..count)
        .rev()
        .map(|i| CommitNode {
            id: format!("{i:040x}"),
            short_id: format!("{i:07x}"),
            message: format!("commit {i}"),
            author_name: "Bench".to_string(),
            author_email: "bench@example.com".to_string(),
            timestamp: 1_700_000_000 + i as i64,
            parent_ids: if i == 0 {
                vec![]
            } else if i % 25 == 0 && i >= 3 {
                vec![format!("{:040x}", i - 1), format!("{:040x}", i - 3)]
            } else {
                vec![format!("{:040x}", i - 1)]
            },
            refs: vec![],
            lane: 0,
            lane_color: 0,
        })
        .collect()
}

/// 把毫秒结果写入 JSON（CI 退化对比用）。
fn write_report(metrics: &[(&str, f64)]) {
    let json = {
        let mut obj = String::from("{");
        for (i, (k, v)) in metrics.iter().enumerate() {
            if i > 0 {
                obj.push(',');
            }
            obj.push_str(&format!("\"{k}\":{v:.3}"));
        }
        obj.push('}');
        obj
    };
    let dir = std::path::Path::new("target");
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join("perf-report.json"), format!("{json}\n"));
}

fn main() {
    // 1. 10 万提交仓库首屏（RepoManager::open + revwalk + 图布局首屏 100 条）
    let repo_dir = build_large_repo(100_000);
    let manager = RepoManager::new();
    let info = manager.open(repo_dir.path()).expect("open 失败");
    let entry_arc = manager.entry(&info.id).expect("entry 失败");
    let entry = lock_entry(&entry_arc);

    let t0 = Instant::now();
    let (commits, has_more) = git_service::load_commit_page(&entry.repo, None, 100, None).unwrap();
    let t_walk = t0.elapsed();
    let mut gs = GraphState::new();
    let rows = gs.compute_graph_rows(commits);
    let t_first_screen = t0.elapsed();
    drop(entry);
    assert!(has_more);
    assert_eq!(rows.len(), 100);

    // 2. 图布局分页耗时（1000 条按每页 100 条分 10 页增量计算）
    let sample = synthetic_graph_commits(1000);
    let t1 = Instant::now();
    let mut paged_gs = GraphState::new();
    for chunk in sample.chunks(100) {
        let _ = paged_gs.compute_graph_rows(chunk.to_vec());
    }
    let t_graph_1k = t1.elapsed();

    // 3. Diff 5 万行耗时（约 10% 修改行：50 个连续 hunk，每个 100 行）
    let old_text: String = (0..50_000)
        .map(|i| format!("line_content_{i:06}\n"))
        .collect();
    let new_hunk_text: String = (0..50_000)
        .map(|i| {
            if i % 1_000 < 100 {
                format!("line_updated_{i:06}_extra\n")
            } else {
                format!("line_content_{i:06}\n")
            }
        })
        .collect();
    let t2 = Instant::now();
    let diff_rows = diff_engine::diff_strings(&old_text, &new_hunk_text, &DiffOptions::default());
    let t_diff_50k = t2.elapsed();
    assert!(diff_rows.len() >= 50_000);

    // 4. 极端分散单行修改压力观测（5000 个独立单行 hunk）
    let scattered_text: String = (0..50_000)
        .map(|i| {
            if i % 10 == 0 {
                format!("line_updated_{i:06}_extra\n")
            } else {
                format!("line_content_{i:06}\n")
            }
        })
        .collect();
    let t3 = Instant::now();
    let scattered_rows =
        diff_engine::diff_strings(&old_text, &scattered_text, &DiffOptions::default());
    let t_diff_scattered = t3.elapsed();
    assert!(scattered_rows.len() >= 50_000);

    // 5. 状态刷新（v0.8 / 8.3 验收 < 500ms）：2000 文件、200 处未暂存修改。
    {
        use std::io::Write as _;
        let mut child = Command::new("git")
            .current_dir(repo_dir.path())
            .args(["fast-import", "--quiet"])
            .stdin(Stdio::piped())
            .spawn()
            .expect("启动 fast-import 失败");
        {
            let mut stdin = std::io::BufWriter::new(child.stdin.take().expect("stdin"));
            for f in 0..2_000 {
                let content = format!("file-{f}\n");
                writeln!(
                    stdin,
                    "blob\nmark :{m}\ndata {len}\n{content}",
                    m = 10_000 + f,
                    len = content.len(),
                )
                .unwrap();
            }
            let msg = "dirty 2000";
            writeln!(
                stdin,
                "commit refs/heads/dirty\nmark :99999\nauthor Bench <b@e.com> 1700000500 +0000\ncommitter Bench <b@e.com> 1700000500 +0000\ndata {mlen}\n{msg}\nfrom refs/heads/main",
                mlen = msg.len(),
            )
            .unwrap();
            for f in 0..2_000 {
                writeln!(
                    stdin,
                    "M 100644 :{m} dir{d}/file{f}.txt",
                    m = 10_000 + f,
                    d = f % 20
                )
                .unwrap();
            }
            writeln!(stdin, "done").unwrap();
        }
        assert!(child.wait().expect("fast-import").success());
        run_git_cmd(repo_dir.path(), &["checkout", "-q", "refs/heads/dirty"]);
        // 制造未暂存修改
        for f in 0..200 {
            let p = repo_dir.path().join(format!("dir{}/file{}.txt", f % 20, f));
            std::fs::write(&p, format!("dirty-{f}\n")).unwrap();
        }
    }
    let t4 = Instant::now();
    let statuses = {
        let e2 = manager.entry(&info.id).expect("entry 失败");
        let entry2 = lock_entry(&e2);
        git_service::status(&entry2.repo).expect("status 失败")
    };
    let t_status = t4.elapsed();
    assert_eq!(statuses.len(), 200, "应恰好检测到 200 处未暂存修改");

    // 6. commit-graph 加速对比（v0.8 / 8.3）：写入前后各测一次首屏 revwalk。
    let t5 = Instant::now();
    {
        let e2 = manager.entry(&info.id).expect("entry 失败");
        let entry2 = lock_entry(&e2);
        let _ = git_service::load_commit_page(&entry2.repo, None, 100, None).unwrap();
    }
    let t_before_graph = t5.elapsed();
    run_git_cmd(
        repo_dir.path(),
        &["commit-graph", "write", "--reachable", "--split"],
    );
    let t6 = Instant::now();
    {
        let e2 = manager.entry(&info.id).expect("entry 失败");
        let entry2 = lock_entry(&e2);
        let _ = git_service::load_commit_page(&entry2.repo, None, 100, None).unwrap();
    }
    let t_after_graph = t6.elapsed();

    let report = format!(
        "| Benchmark | Result | Target |\n\
         |---|---|---|\n\
         | 100k commits revwalk (100 rows) | {:.2} ms | - |\n\
         | 100k commits first screen (walk + layout) | {:.2} ms | < 1000 ms |\n\
         | Graph layout (10x100 paged rows) | {:.2} ms | < 50 ms |\n\
         | Diff 50k lines (10% modified, 50 hunks) | {:.2} ms | < 500 ms |\n\
         | Diff 50k lines (5k scattered hunks, stress) | {:.2} ms | - |\n\
         | Status refresh (2k files, 200 dirty) | {:.2} ms | < 500 ms |\n\
         | 100k first screen BEFORE commit-graph | {:.2} ms | - |\n\
         | 100k first screen AFTER commit-graph | {:.2} ms | - |\n",
        t_walk.as_secs_f64() * 1000.0,
        t_first_screen.as_secs_f64() * 1000.0,
        t_graph_1k.as_secs_f64() * 1000.0,
        t_diff_50k.as_secs_f64() * 1000.0,
        t_diff_scattered.as_secs_f64() * 1000.0,
        t_status.as_secs_f64() * 1000.0,
        t_before_graph.as_secs_f64() * 1000.0,
        t_after_graph.as_secs_f64() * 1000.0,
    );

    write_report(&[
        ("first_screen_ms", t_first_screen.as_secs_f64() * 1000.0),
        ("graph_layout_1k_ms", t_graph_1k.as_secs_f64() * 1000.0),
        ("diff_50k_ms", t_diff_50k.as_secs_f64() * 1000.0),
        ("status_refresh_ms", t_status.as_secs_f64() * 1000.0),
    ]);
    println!("\n{report}");

    if let Ok(summary_path) = std::env::var("GITHUB_STEP_SUMMARY")
        && let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(summary_path)
    {
        let _ = writeln!(f, "### OpenPatchline Rust Benchmarks\n\n{report}");
    }

    assert!(
        t_first_screen.as_millis() < 1000,
        "100k commits first screen exceeded 1000ms: {:?}",
        t_first_screen
    );
    assert!(
        t_status.as_millis() < 500,
        "状态刷新超过 500ms 预算（v0.8 / 8.3 验收）: {:?}",
        t_status
    );
}

/// 基准内直接跑 git CLI（工作目录已存在）。
fn run_git_cmd(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("执行 git 失败");
    assert!(
        out.status.success(),
        "git {:?} 失败: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}
