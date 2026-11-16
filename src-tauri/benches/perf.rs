//! 性能基准（Task 3.5）：10 万提交首屏、图布局分页耗时、5 万行 Diff 耗时。
//!
//! 运行方式：`cargo bench --manifest-path src-tauri/Cargo.toml`
//! 若设置 `GITHUB_STEP_SUMMARY`，同步输出 Markdown 表格到 CI Summary。

use std::io::Write;
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

    let report = format!(
        "| Benchmark | Result | Target |\n\
         |---|---|---|\n\
         | 100k commits revwalk (100 rows) | {:.2} ms | - |\n\
         | 100k commits first screen (walk + layout) | {:.2} ms | < 1000 ms |\n\
         | Graph layout (10x100 paged rows) | {:.2} ms | < 50 ms |\n\
         | Diff 50k lines (10% modified, 50 hunks) | {:.2} ms | < 500 ms |\n\
         | Diff 50k lines (5k scattered hunks, stress) | {:.2} ms | - |\n",
        t_walk.as_secs_f64() * 1000.0,
        t_first_screen.as_secs_f64() * 1000.0,
        t_graph_1k.as_secs_f64() * 1000.0,
        t_diff_50k.as_secs_f64() * 1000.0,
        t_diff_scattered.as_secs_f64() * 1000.0,
    );
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
}
