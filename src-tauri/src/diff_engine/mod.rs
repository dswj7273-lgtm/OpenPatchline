//! Diff Engine：文本 diff 计算管线（docs/05-diff-engine.md）。
//!
//! Phase 1 Histogram 行级 diff（[`diff_rec`]，无公共锚点的区间回退 Myers）→
//! Phase 2/3 hunk 构建与行对齐（[`align`]：v1 保留全部上下文行，变更块内
//! Removed/Added 逐对同行配对）→ Phase 4 字符级高亮（[`char_diff`]）。
//! 最终输出左右等长、可直接虚拟化渲染的 [`AlignedRow`] 列表。

pub(crate) mod align;
pub(crate) mod char_diff;

use std::collections::{HashMap, HashSet};

use crate::types::{AlignedRow, LineKind};

/// 行级 Myers 回退的最大区间规模（旧 + 新行数，约 2000 行/侧）。
///
/// 超过该规模且无公共锚点的区间不再运行 Myers，直接按“整块替换”处理
/// （任务书指定的大区间启发式）：无公共行时 LCS 为空，整块替换本身就是
/// Myers 的最优解，因此该截断只影响性能、不影响正确性；仅有公共行但
/// 超过递归深度上限的区间属于有损启发（见 [`MAX_DEPTH`]）。
const MYERS_MAX_REGION: usize = 4000;

/// Myers 轨迹回溯的编辑距离上限；超过则按整块替换回退（大区间保护）。
const MYERS_MAX_D: usize = 1024;

/// histogram 递归深度上限：超过后当前区间不再寻找锚点，直接走
/// Myers / 整块替换（正确性不变，仅 diff 粒度可能变粗）。
const MAX_DEPTH: usize = 512;

/// diff 计算选项。
#[derive(Debug, Clone, Copy, Default)]
pub struct DiffOptions {
    /// 比较行内容时忽略空白差异：哈希/比较使用规范化形式
    /// （去首尾空白 + 内部连续空白折叠为单个空格），展示仍保留原文。
    pub ignore_whitespace: bool,
    /// 输出的最大行数（对齐后 AlignedRow 数）；0 = 不限制。
    ///
    /// 引擎总是完整计算后再截断：仅在结果行数超过 `max_rows` 时返回前
    /// `max_rows` 行，被截断部分的内容正确性不受影响。调用方应事先依据
    /// 文件大小/行数阈值（docs/05 §8）判定 too_large，而不是依赖本字段。
    pub max_rows: usize,
}

/// Phase 1 输出：基于行下标的原始操作（run 形式，完整覆盖 old/new 两侧）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum RawOp {
    /// `old[old_start..old_start+len]` 与 `new[new_start..new_start+len]` 相同。
    Equal {
        old_start: usize,
        new_start: usize,
        len: usize,
    },
    /// `old[old_start..old_start+len]` 被删除。
    Remove { old_start: usize, len: usize },
    /// `new[new_start..new_start+len]` 为新增。
    Add { new_start: usize, len: usize },
}

/// 计算两段文本的左右分栏 diff（docs/05 §4–§7 的完整管线）。
///
/// - `old` → 左侧（Removed），`new` → 右侧（Added）；
/// - Phase 1：histogram 行级 diff；无公共锚点的区间回退 Myers，超大区间
///   按整块替换保护（见 [`MYERS_MAX_REGION`]）；
/// - Phase 2/3：hunk 与行对齐。v1 保留全部上下文行（不折叠，交给前端
///   虚拟列表渲染）；变更块内第 i 个 Removed 与第 i 个 Added 同行配对
///   （字符级 diff 的作用对象），多余行以单侧 `None` 占位；
/// - Phase 4：对“相似”的修改对填充字符级高亮区间（`char_ranges`，
///   字符偏移）；
/// - 行切分仅以 `'\n'` 为终结符，`'\r'` 属于行内容（整文件 CRLF↔LF 翻转
///   呈现为逐行修改，见 [`split_lines`]）；仅末行换行终结符（EOF `'\n'`
///   有无）不同时，末行呈现为 Removed/Added 修改对（对齐 git 的
///   `\ No newline at end of file` 语义）；
/// - `max_rows > 0` 时完整计算后仅返回前 `max_rows` 行（见
///   [`DiffOptions::max_rows`]）。
pub fn diff_strings(old: &str, new: &str, opts: &DiffOptions) -> Vec<AlignedRow> {
    let old_lines = split_lines(old);
    let new_lines = split_lines(new);

    // 行内建为 id：ignore_whitespace 时以规范化形式为 key，展示仍用原文。
    let mut table: HashMap<Box<str>, u32> = HashMap::new();
    let mut old_ids = intern_lines(&old_lines, opts.ignore_whitespace, &mut table);
    let mut new_ids = intern_lines(&new_lines, opts.ignore_whitespace, &mut table);

    // 仅末行换行终结符不同：未终结一侧的末行改为全新 id（`table.len()`
    // 尚未分配给任何行），使其不再与对侧同内容行匹配为上下文，而是呈现为
    // 修改对；两侧终结状态一致时不受影响。
    if old.ends_with('\n') != new.ends_with('\n') {
        let fresh = table.len() as u32;
        if old.ends_with('\n') {
            if let Some(last) = new_ids.last_mut() {
                *last = fresh;
            }
        } else if let Some(last) = old_ids.last_mut() {
            *last = fresh;
        }
    }

    // Phase 1：histogram diff，输出覆盖两侧的原始操作序列
    let mut ops = Vec::new();
    diff_rec(&old_ids, &new_ids, 0, 0, 0, &mut ops);

    // Phase 2/3：行对齐（上下文行 / 修改对 / 单侧占位）
    let mut rows = align::align_ops(&ops, &old_lines, &new_lines);

    // Phase 4：字符级高亮
    char_diff::highlight_rows(&mut rows);

    // 行数截断（语义见 DiffOptions::max_rows 文档）
    if opts.max_rows > 0 && rows.len() > opts.max_rows {
        rows.truncate(opts.max_rows);
    }
    rows
}

/// 变更行下标：`left.kind == Removed || right.kind == Added` 的行。
///
/// 上下文行与占位行（某侧为 None）不包含在内；返回值升序，
/// 供前端“上一处/下一处变更”导航使用。
pub fn compute_change_row_indices(rows: &[AlignedRow]) -> Vec<usize> {
    rows.iter()
        .enumerate()
        .filter(|(_, r)| {
            r.left.as_ref().is_some_and(|c| c.kind == LineKind::Removed)
                || r.right.as_ref().is_some_and(|c| c.kind == LineKind::Added)
        })
        .map(|(i, _)| i)
        .collect()
}

/// 统计 `(additions, deletions)`。
///
/// 按 RowCell 计数：右侧 Added 记一次 addition，左侧 Removed 记一次
/// deletion；修改对（左 Removed + 右 Added 同行）各记一次；Context 与
/// 占位不计数。
pub fn compute_stats(rows: &[AlignedRow]) -> (u32, u32) {
    let (mut additions, mut deletions) = (0usize, 0usize);
    for row in rows {
        if row.right.as_ref().is_some_and(|c| c.kind == LineKind::Added) {
            additions += 1;
        }
        if row.left.as_ref().is_some_and(|c| c.kind == LineKind::Removed) {
            deletions += 1;
        }
    }
    (
        u32::try_from(additions).unwrap_or(u32::MAX),
        u32::try_from(deletions).unwrap_or(u32::MAX),
    )
}

/// 按行切分：仅去掉行尾 `'\n'` 终结符；末行没有换行符也计入，空串为 0 行。
///
/// `'\r'` 一律视为行内容的一部分（与 git 相同）：CRLF 行尾的 `'\r'` 参与
/// 比较与展示，因此整文件 CRLF↔LF 翻转会正确呈现为逐行修改而不是零差异
/// （对齐 `git diff` 默认行为；`--ignore-cr-at-eol` 风格的宽容比较属
/// `ignore_whitespace` 之外的独立选项，v1 不提供）；未以 `'\n'` 终结的
/// 末行尾部的 `'\r'` 同样按内容原样保留。
fn split_lines(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return Vec::new();
    }
    s.split_terminator('\n').collect()
}

/// 行规范化（`ignore_whitespace` 用）：去首尾空白 + 内部连续空白折叠为单个空格。
fn normalize_ws_into(out: &mut String, s: &str) {
    out.clear();
    let mut first = true;
    for word in s.split_whitespace() {
        if !first {
            out.push(' ');
        }
        out.push_str(word);
        first = false;
    }
}

/// 行内建为 id：相同（或规范化后相同）内容的行共享同一 id。
fn intern_lines(
    lines: &[&str],
    ignore_ws: bool,
    table: &mut HashMap<Box<str>, u32>,
) -> Vec<u32> {
    let mut ids = Vec::with_capacity(lines.len());
    let mut norm = String::new();
    for &line in lines {
        let key: &str = if ignore_ws {
            normalize_ws_into(&mut norm, line);
            &norm
        } else {
            line
        };
        let id = match table.get(key) {
            Some(&id) => id,
            None => {
                let id = table.len() as u32;
                table.insert(key.into(), id);
                id
            }
        };
        ids.push(id);
    }
    ids
}

/// Phase 1：histogram diff 递归（docs/05 §4）。
///
/// 每层先裁剪公共前后缀，再在剩余区间统计两侧行出现次数，选“最稀有”的
/// 公共行作锚点并向两侧扩展成最大公共 run，然后分割递归；无公共锚点时
/// 回退 Myers（区间过大则按整块替换，见 [`MYERS_MAX_REGION`]）。
/// `old_base` / `new_base` 为当前区间在完整行数组中的绝对下标偏移。
fn diff_rec(
    old: &[u32],
    new: &[u32],
    old_base: usize,
    new_base: usize,
    depth: usize,
    out: &mut Vec<RawOp>,
) {
    if old.is_empty() {
        if !new.is_empty() {
            out.push(RawOp::Add {
                new_start: new_base,
                len: new.len(),
            });
        }
        return;
    }
    if new.is_empty() {
        out.push(RawOp::Remove {
            old_start: old_base,
            len: old.len(),
        });
        return;
    }

    // 公共前后缀（每层都裁剪，显著约束递归规模）
    let p = old
        .iter()
        .zip(new)
        .take_while(|(a, b)| a == b)
        .count();
    let s = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take_while(|(a, b)| a == b)
        .count()
        .min(old.len() - p)
        .min(new.len() - p);
    if p > 0 {
        out.push(RawOp::Equal {
            old_start: old_base,
            new_start: new_base,
            len: p,
        });
    }

    let (om, nm) = (&old[p..old.len() - s], &new[p..new.len() - s]);
    let (ob, nb) = (old_base + p, new_base + p);
    match (om.is_empty(), nm.is_empty()) {
        (true, true) => {}
        (true, false) => out.push(RawOp::Add {
            new_start: nb,
            len: nm.len(),
        }),
        (false, true) => out.push(RawOp::Remove {
            old_start: ob,
            len: om.len(),
        }),
        (false, false) => {
            let anchor = if depth < MAX_DEPTH {
                find_anchor(om, nm)
            } else {
                None
            };
            if let Some((oi, ni)) = anchor {
                // 锚点扩展为最大公共 run（“最低出现次数的公共行区域”）
                let (mut a, mut b) = (oi, ni);
                while a > 0 && b > 0 && om[a - 1] == nm[b - 1] {
                    a -= 1;
                    b -= 1;
                }
                let (mut ae, mut be) = (oi + 1, ni + 1);
                while ae < om.len() && be < nm.len() && om[ae] == nm[be] {
                    ae += 1;
                    be += 1;
                }
                diff_rec(&om[..a], &nm[..b], ob, nb, depth + 1, out);
                out.push(RawOp::Equal {
                    old_start: ob + a,
                    new_start: nb + b,
                    len: ae - a,
                });
                diff_rec(&om[ae..], &nm[be..], ob + ae, nb + be, depth + 1, out);
            } else if om.len() + nm.len() > MYERS_MAX_REGION {
                // 大区间保护（无锚点或超深度）：整块替换。无公共行时这就是
                // Myers 的最优解；超深度时为有损启发（正确性不变）。
                out.push(RawOp::Remove {
                    old_start: ob,
                    len: om.len(),
                });
                out.push(RawOp::Add {
                    new_start: nb,
                    len: nm.len(),
                });
            } else {
                myers_ops(om, nm, ob, nb, out);
            }
        }
    }

    if s > 0 {
        out.push(RawOp::Equal {
            old_start: old_base + old.len() - s,
            new_start: new_base + new.len() - s,
            len: s,
        });
    }
}

/// 在两个区间中寻找“最稀有”的公共行锚点（docs/05 §4 `find_best_anchor`）。
///
/// 返回 `(old 位置, new 首次出现位置)`；评分为两侧行出现次数之和，评分
/// 越小越“稀有”。仅按评分无法区分并列候选（例如整段重排时所有唯一行
/// 评分相同，而不同候选锚定的公共 run 长度可能相差悬殊），因此评分并列
/// 时优先选择双向扩展出的最大公共 run 更长者（避免把长公共段整体重写为
/// Remove+Add），run 等长时取 new 侧起点更靠前者（与 git histogram 的
/// 扫描序一致）。复杂度 O(|old| + |new| + 扩展预算)。
///
/// 实现要点：同一对齐偏移上、落在已扩展 run 内部的候选，其最大 run 与该
/// run 完全相同，直接复用结果（每个 run 至多完整扩展一次）；双向扩展的
/// 总步数受预算约束，周期性重复内容等病态输入下耗尽预算即停止精化
/// （保留当前最优，仅该层 diff 粒度可能变粗，正确性不受影响）。
fn find_anchor(old: &[u32], new: &[u32]) -> Option<(usize, usize)> {
    // new 侧：行 → (出现次数, 首次出现下标)
    let mut new_info: HashMap<u32, (u32, usize)> = HashMap::with_capacity(new.len());
    for (i, &line) in new.iter().enumerate() {
        new_info.entry(line).or_insert((0, i)).0 += 1;
    }
    let mut old_count: HashMap<u32, u32> = HashMap::with_capacity(old.len());
    for &line in old {
        *old_count.entry(line).or_insert(0) += 1;
    }

    // 并列候选 run 扩展的总步数预算（约几倍区间长度）
    let mut budget: usize = 4 * (old.len() + new.len()) + 4096;

    // best: (评分, run 长度, run 的 new 侧起点, old 位置, new 位置)。
    // 比较序：评分升序 → run 长度降序 → run 的 new 侧起点升序。
    let mut best: Option<(u32, usize, usize, usize, usize)> = None;
    // 对齐偏移 → 已扩展 run 的 (old 侧起点 a, old 侧终点 ae, new 侧起点 b)
    let mut runs: HashMap<isize, (usize, usize, usize)> = HashMap::new();

    for (i, &line) in old.iter().enumerate() {
        let Some(&(nc, nf)) = new_info.get(&line) else {
            continue;
        };
        let score = old_count.get(&line).copied().unwrap_or(0) + nc;
        let offset = nf as isize - i as isize;
        let hit = runs.get(&offset).copied();
        let (run_len, run_new_start) = match hit {
            // 落在同偏移已扩展 run 内部：最大 run 与其相同，免扩展复用
            Some((a, ae, b)) if i < ae => (ae - a, b),
            _ => {
                if budget == 0 {
                    break;
                }
                let (mut a, mut b) = (i, nf);
                while budget > 0 && a > 0 && b > 0 && old[a - 1] == new[b - 1] {
                    a -= 1;
                    b -= 1;
                    budget -= 1;
                }
                let (mut ae, mut be) = (i + 1, nf + 1);
                while budget > 0 && ae < old.len() && be < new.len() && old[ae] == new[be] {
                    ae += 1;
                    be += 1;
                    budget -= 1;
                }
                runs.insert(offset, (a, ae, b));
                (ae - a, b)
            }
        };
        let better = match best {
            None => true,
            Some((bs, bl, bn, _, _)) => {
                score < bs
                    || (score == bs && (run_len > bl || (run_len == bl && run_new_start < bn)))
            }
        };
        if better {
            best = Some((score, run_len, run_new_start, i, nf));
        }
    }
    best.map(|(_, _, _, i, j)| (i, j))
}

/// 通用 Myers diff（O(ND) 前向搜索 + 轨迹回溯），行级回退与字符级 diff 共用。
///
/// 输出以 `a` / `b` 下标表示、合并为连续 run 的操作序列（加上 `a_off` /
/// `b_off` 绝对偏移）。短路路径：任一侧为空；两序列完全无公共元素（此时
/// LCS 为空，整块替换即最优编辑脚本，同时也是 Myers 的最坏情况）；公共
/// 前后缀裁剪。编辑距离超过 [`MYERS_MAX_D`] 时按整块替换回退。
fn myers_ops<T: Eq + std::hash::Hash>(
    a: &[T],
    b: &[T],
    a_off: usize,
    b_off: usize,
    out: &mut Vec<RawOp>,
) {
    let (n, m) = (a.len(), b.len());
    if n == 0 && m == 0 {
        return;
    }
    if n == 0 {
        out.push(RawOp::Add {
            new_start: b_off,
            len: m,
        });
        return;
    }
    if m == 0 {
        out.push(RawOp::Remove {
            old_start: a_off,
            len: n,
        });
        return;
    }

    // 无公共元素：最优脚本就是整块替换（同时规避 O(ND) 最坏情况）
    let b_set: HashSet<&T> = b.iter().collect();
    if !a.iter().any(|x| b_set.contains(x)) {
        out.push(RawOp::Remove {
            old_start: a_off,
            len: n,
        });
        out.push(RawOp::Add {
            new_start: b_off,
            len: m,
        });
        return;
    }

    // 公共前后缀
    let p = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let s = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count()
        .min(n - p)
        .min(m - p);
    if p > 0 {
        out.push(RawOp::Equal {
            old_start: a_off,
            new_start: b_off,
            len: p,
        });
    }
    let (am, bm) = (&a[p..n - s], &b[p..m - s]);
    let (ob, nb) = (a_off + p, b_off + p);
    match (am.is_empty(), bm.is_empty()) {
        (true, true) => {}
        (true, false) => out.push(RawOp::Add {
            new_start: nb,
            len: bm.len(),
        }),
        (false, true) => out.push(RawOp::Remove {
            old_start: ob,
            len: am.len(),
        }),
        (false, false) => myers_core(am, bm, ob, nb, out),
    }
    if s > 0 {
        out.push(RawOp::Equal {
            old_start: a_off + n - s,
            new_start: b_off + m - s,
            len: s,
        });
    }
}

/// 回溯过程中的路径片段（局部下标，逆序收集）。
#[derive(Debug)]
enum Seg {
    /// 对角线公共 run：a[a..a+len] == b[b..b+len]。
    Eq { a: usize, b: usize, len: usize },
    /// 删除 a[a]。
    Del { a: usize },
    /// 插入 b[b]。
    Ins { b: usize },
}

/// Myers 核心：作用于已裁剪公共前后缀、存在公共元素的中段。
///
/// 经典前向 D-路径搜索（`v[k]` 为对角线 k 上最远到达的 x），每步保存
/// 对角线切片用于回溯；从 (n, m) 逆序还原编辑与对角线 run 后合并输出。
fn myers_core<T: Eq>(am: &[T], bm: &[T], a_off: usize, b_off: usize, out: &mut Vec<RawOp>) {
    let (n, m) = (am.len() as isize, bm.len() as isize);
    let max_d = n + m;
    let delta = n - m;
    let mut v = vec![0isize; (2 * max_d + 1) as usize];
    // trace[j]：第 j 步结束后对角线 [-j, j] 上的最远 x（总内存 O(D²)，受
    // MYERS_MAX_D 约束）
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut final_d: isize = -1;
    let mut d: isize = 0;
    while d <= max_d {
        if d as usize > MYERS_MAX_D {
            // 编辑距离超限：按整块替换回退（大区间保护）
            out.push(RawOp::Remove {
                old_start: a_off,
                len: am.len(),
            });
            out.push(RawOp::Add {
                new_start: b_off,
                len: bm.len(),
            });
            return;
        }
        let mut hit = false;
        let mut k = -d;
        while k <= d {
            let down = k == -d
                || (k != d && v[(k - 1 + max_d) as usize] < v[(k + 1 + max_d) as usize]);
            let mut x = if down {
                v[(k + 1 + max_d) as usize]
            } else {
                v[(k - 1 + max_d) as usize] + 1
            };
            let mut y = x - k;
            while x < n && y < m && am[x as usize] == bm[y as usize] {
                x += 1;
                y += 1;
            }
            v[(k + max_d) as usize] = x;
            if k == delta && x >= n && y >= m {
                hit = true;
            }
            k += 2;
        }
        trace.push(v[(max_d - d) as usize..=(max_d + d) as usize].to_vec());
        if hit {
            final_d = d;
            break;
        }
        d += 1;
    }
    if final_d < 0 {
        // 理论上 D ≤ n + m 必然命中；防御性回退，保证输出始终覆盖两侧。
        out.push(RawOp::Remove {
            old_start: a_off,
            len: am.len(),
        });
        out.push(RawOp::Add {
            new_start: b_off,
            len: bm.len(),
        });
        return;
    }

    // 回溯：从 (n, m) 逆序收集编辑与对角线 run
    let mut segs: Vec<Seg> = Vec::with_capacity((final_d as usize) * 2 + 1);
    let (mut x, mut y) = (n, m);
    let mut j = final_d;
    while j >= 1 {
        let vprev = &trace[(j - 1) as usize];
        let k = x - y;
        let down = k == -j
            || (k != j && vprev[(k - 1 + j - 1) as usize] < vprev[(k + 1 + j - 1) as usize]);
        let prev_k = if down { k + 1 } else { k - 1 };
        let prev_x = vprev[(prev_k + j - 1) as usize];
        let prev_y = prev_x - prev_k;
        // 本步编辑后的位置（对角线 run 的起点）
        let (post_x, post_y) = if down {
            (prev_x, prev_y + 1)
        } else {
            (prev_x + 1, prev_y)
        };
        let snake = x - post_x;
        debug_assert_eq!(snake, y - post_y);
        if snake > 0 {
            segs.push(Seg::Eq {
                a: post_x as usize,
                b: post_y as usize,
                len: snake as usize,
            });
        }
        if down {
            segs.push(Seg::Ins {
                b: prev_y as usize,
            });
        } else {
            segs.push(Seg::Del {
                a: prev_x as usize,
            });
        }
        x = prev_x;
        y = prev_y;
        j -= 1;
    }
    // 剩余的初始对角线 run（调用前已裁剪公共前缀，正常应为 0）
    debug_assert_eq!((x, y), (0, 0));
    if x > 0 {
        segs.push(Seg::Eq {
            a: 0,
            b: 0,
            len: x as usize,
        });
    }
    segs.reverse();

    // 顺序输出并合并相邻同类型片段
    let (mut ax, mut bx) = (0usize, 0usize);
    for seg in segs {
        match seg {
            Seg::Eq { a, b, len } => {
                debug_assert_eq!((a, b), (ax, bx));
                out.push(RawOp::Equal {
                    old_start: a_off + a,
                    new_start: b_off + b,
                    len,
                });
                ax += len;
                bx += len;
            }
            Seg::Del { a } => {
                debug_assert_eq!(a, ax);
                let abs = a_off + a;
                match out.last_mut() {
                    Some(RawOp::Remove { old_start, len }) if *old_start + *len == abs => {
                        *len += 1;
                    }
                    _ => out.push(RawOp::Remove {
                        old_start: abs,
                        len: 1,
                    }),
                }
                ax += 1;
            }
            Seg::Ins { b } => {
                debug_assert_eq!(b, bx);
                let abs = b_off + b;
                match out.last_mut() {
                    Some(RawOp::Add { new_start, len }) if *new_start + *len == abs => {
                        *len += 1;
                    }
                    _ => out.push(RawOp::Add {
                        new_start: abs,
                        len: 1,
                    }),
                }
                bx += 1;
            }
        }
    }
    debug_assert_eq!((ax, bx), (am.len(), bm.len()));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 覆盖重建、对齐不变量等性质测试的代表性输入。
    const CASES: &[(&str, &str)] = &[
        // 完全相同
        (
            "fn main() {\n    let a = 1;\n}\n",
            "fn main() {\n    let a = 1;\n}\n",
        ),
        // 空对空
        ("", ""),
        // 单侧为空
        ("", "a\nb\n"),
        ("a\nb\n", ""),
        // 末行无换行符
        ("a\nb", "a\nc"),
        // 典型代码编辑：修改 + 插入 + 删除
        (
            "alpha\nbravo\ncharlie\ndelta\necho\n",
            "alpha\nbravo\nxray\ndelta\nfoxtrot\n",
        ),
        // 块移动
        ("a\nb\nc\nX\nY\nZ\nd\ne\nf\n", "a\nb\nc\nd\ne\nf\nX\nY\nZ\n"),
        // 重复出现的行
        ("a\nb\na\nb", "b\na\nb\na"),
        // 大量重复结构（花括号 / 空行）
        (
            "fn a() {\n    1\n}\n\nfn b() {\n    2\n}\n\nfn c() {\n    3\n}\n",
            "fn a() {\n    1\n}\n\nfn b() {\n    two\n}\n\nfn c() {\n    3\n}\n",
        ),
        // 完全无公共行的区域
        ("1\n2\n3\n", "x\ny\nz\nw\n"),
        // 纯空白差异（ignore_whitespace 关闭时是修改对）
        ("fn f() {\n    return 1;\n}\n", "fn f() {\n\treturn 1;   \n}\n"),
        // 整文件行尾风格翻转（CRLF -> LF）
        ("a\r\nb\r\nc\r\n", "a\nb\nc\n"),
        // 仅末行换行终结符（EOF '\n'）不同
        ("a\nb", "a\nb\n"),
        ("a\nb\n", "a\nb"),
        // 未终结末行尾部的 '\r' 属于内容
        ("a\nb\r", "a\nb\r\n"),
        // 交错重排（块移动的最小 diff）
        (
            "x1\nm1\nm2\nx2\nx3\nn1\nn2\nx4\n",
            "x1\nx2\nn1\nn2\nx3\nm1\nm2\nx4\n",
        ),
    ];

    fn diff(old: &str, new: &str) -> Vec<AlignedRow> {
        diff_strings(old, new, &DiffOptions::default())
    }

    fn lines_of(s: &str) -> Vec<String> {
        split_lines(s).into_iter().map(str::to_string).collect()
    }

    /// 由行分类重建 new（walk rows：context 保留、added 插入、removed 丢弃）。
    fn rebuild_new(rows: &[AlignedRow]) -> Vec<String> {
        rows.iter()
            .filter_map(|r| r.right.as_ref().map(|c| c.content.clone()))
            .collect()
    }

    /// 由行分类重建 old（对称方向）。
    fn rebuild_old(rows: &[AlignedRow]) -> Vec<String> {
        rows.iter()
            .filter_map(|r| r.left.as_ref().map(|c| c.content.clone()))
            .collect()
    }

    /// 对齐不变量：任一行两侧不同时为 None；两侧行号严格递增；
    /// 上下文行两侧内容一致（ignore_whitespace 时按规范化比较）。
    fn assert_invariants(rows: &[AlignedRow], ignore_ws: bool) {
        let (mut last_old, mut last_new) = (None, None);
        for (i, row) in rows.iter().enumerate() {
            assert!(
                !(row.left.is_none() && row.right.is_none()),
                "row {i}: 两侧均为 None"
            );
            for (cell, last) in [(&row.left, &mut last_old), (&row.right, &mut last_new)] {
                if let Some(c) = cell {
                    if let Some(n) = c.lineno {
                        if let Some(l) = *last {
                            assert!(n > l, "row {i}: 行号未严格递增 ({l} -> {n})");
                        }
                        *last = Some(n);
                    }
                }
            }
            if let (Some(l), Some(r)) = (&row.left, &row.right) {
                if l.kind == LineKind::Removed && r.kind == LineKind::Added {
                    continue; // 修改对内容允许不同
                }
                let eq = if ignore_ws {
                    let (mut a, mut b) = (String::new(), String::new());
                    normalize_ws_into(&mut a, &l.content);
                    normalize_ws_into(&mut b, &r.content);
                    a == b
                } else {
                    l.content == r.content
                };
                assert!(eq, "row {i}: 上下文行内容不一致 {:?} != {:?}", l.content, r.content);
            }
        }
    }

    #[test]
    fn reconstruct_all_cases() {
        for (old, new) in CASES {
            let rows = diff(old, new);
            assert_eq!(
                rebuild_new(&rows),
                lines_of(new),
                "重建 new 失败: old={old:?} new={new:?}"
            );
            assert_eq!(
                rebuild_old(&rows),
                lines_of(old),
                "重建 old 失败: old={old:?} new={new:?}"
            );
            assert_invariants(&rows, false);
        }
    }

    #[test]
    fn alignment_invariants() {
        // 所有用例（含 ignore_whitespace 两种模式）下检查对齐不变量
        for (old, new) in CASES {
            for ignore_ws in [false, true] {
                let rows = diff_strings(
                    old,
                    new,
                    &DiffOptions {
                        ignore_whitespace: ignore_ws,
                        max_rows: 0,
                    },
                );
                assert_invariants(&rows, ignore_ws);
            }
        }
    }

    #[test]
    fn identical_and_empty() {
        let rows = diff("x\ny\nz\n", "x\ny\nz\n");
        assert!(rows.iter().all(|r| {
            r.left.as_ref().is_some_and(|c| c.kind == LineKind::Context)
                && r.right.as_ref().is_some_and(|c| c.kind == LineKind::Context)
        }));
        assert_eq!(compute_change_row_indices(&rows), Vec::<usize>::new());
        assert_eq!(compute_stats(&rows), (0, 0));

        assert!(diff("", "").is_empty());

        let rows = diff("", "a\nb\n");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.left.is_none()));
        assert_eq!(compute_stats(&rows), (2, 0));
        assert_eq!(compute_change_row_indices(&rows), vec![0, 1]);

        let rows = diff("a\nb\n", "");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.right.is_none()));
        assert_eq!(compute_stats(&rows), (0, 2));
    }

    #[test]
    fn typical_edit_classification() {
        // 修改 + 插入 + 删除：charlie->xray 与 echo->foxtrot 是修改对，
        // 行号与统计应精确
        let rows = diff(
            "alpha\nbravo\ncharlie\ndelta\necho\n",
            "alpha\nbravo\nxray\ndelta\nfoxtrot\n",
        );
        assert_eq!(rows.len(), 5);
        assert_eq!(compute_change_row_indices(&rows), vec![2, 4]);
        assert_eq!(compute_stats(&rows), (2, 2));
        // 修改对：左 Removed / 右 Added 同行
        let (Some(l), Some(r)) = (&rows[2].left, &rows[2].right) else {
            panic!("row 2 应为修改对");
        };
        assert_eq!(l.kind, LineKind::Removed);
        assert_eq!(r.kind, LineKind::Added);
        assert_eq!(l.content, "charlie");
        assert_eq!(r.content, "xray");
        assert_eq!(l.lineno, Some(3));
        assert_eq!(r.lineno, Some(3));
    }

    #[test]
    fn block_move_and_rotation_minimal() {
        // 整段块移动：长公共段不应被整体重写（与 git histogram 一致：-3/+3）
        let rows = diff(
            "P1\nP2\nP3\nA1\nA2\nA3\nA4\n",
            "A1\nA2\nA3\nA4\nP1\nP2\nP3\n",
        );
        assert_eq!(compute_stats(&rows), (3, 3));
        assert_eq!(rebuild_new(&rows), lines_of("A1\nA2\nA3\nA4\nP1\nP2\nP3\n"));
        assert_eq!(rebuild_old(&rows), lines_of("P1\nP2\nP3\nA1\nA2\nA3\nA4\n"));
        assert_invariants(&rows, false);

        // 交错重排：-3/+3（git histogram 同）
        let rows = diff(
            "x1\nm1\nm2\nx2\nx3\nn1\nn2\nx4\n",
            "x1\nx2\nn1\nn2\nx3\nm1\nm2\nx4\n",
        );
        assert_eq!(compute_stats(&rows), (3, 3));
        assert_invariants(&rows, false);

        // 旋转（首行移到末尾）：仅 -1/+1；覆盖曾触发整体重写（-n/+n）的规模
        for n in [2usize, 4, 10, 100] {
            let lines: Vec<String> = (1..=n).map(|i| format!("line {i:03}")).collect();
            let old = format!("{}\n", lines.join("\n"));
            let new = format!("{}\n{}\n", lines[1..].join("\n"), lines[0]);
            let rows = diff(&old, &new);
            assert_eq!(compute_stats(&rows), (1, 1), "n = {n}");
            assert_eq!(rebuild_new(&rows), lines_of(&new));
            assert_eq!(rebuild_old(&rows), lines_of(&old));
            assert_invariants(&rows, false);
        }
    }

    #[test]
    fn crlf_line_endings() {
        // 整文件 CRLF->LF 翻转：逐行修改（与 git 一致），而不是零差异
        let rows = diff("a\r\nb\r\nc\r\n", "a\nb\nc\n");
        assert_eq!(compute_stats(&rows), (3, 3));
        assert_eq!(compute_change_row_indices(&rows), vec![0, 1, 2]);
        // '\r' 属于行内容：左侧保留（git 亦如此），右侧无
        assert_eq!(
            rows[0].left.as_ref().map(|c| c.content.as_str()),
            Some("a\r")
        );
        assert_eq!(rows[0].right.as_ref().map(|c| c.content.as_str()), Some("a"));
        assert_eq!(rebuild_new(&rows), lines_of("a\nb\nc\n"));
        assert_eq!(rebuild_old(&rows), lines_of("a\r\nb\r\nc\r\n"));
        assert_invariants(&rows, false);

        // 行尾风格一致时不产生差异；单行修改不受影响
        assert_eq!(compute_stats(&diff("a\r\nb\r\n", "a\r\nb\r\n")), (0, 0));
        let rows = diff("a\r\nb\r\n", "a\r\nB\r\n");
        assert_eq!(compute_stats(&rows), (1, 1));
        assert_eq!(
            rows[1].left.as_ref().map(|c| c.content.as_str()),
            Some("b\r")
        );
        assert_eq!(
            rows[1].right.as_ref().map(|c| c.content.as_str()),
            Some("B\r")
        );

        // 未终结末行尾部的 '\r' 属于内容，不得当作 CRLF 终结符丢弃
        assert_eq!(lines_of("a\nb\r"), vec!["a", "b\r"]);
    }

    #[test]
    fn eof_newline_change_is_visible() {
        // 仅末行换行终结符变化：末行呈现为修改对（git 的 \ No newline 语义）
        for (old, new) in [("a\nb", "a\nb\n"), ("a\nb\n", "a\nb")] {
            let rows = diff(old, new);
            assert_eq!(compute_stats(&rows), (1, 1), "old={old:?} new={new:?}");
            assert_eq!(compute_change_row_indices(&rows), vec![1]);
            let (Some(l), Some(r)) = (&rows[1].left, &rows[1].right) else {
                panic!("row 1 应为末行修改对");
            };
            assert_eq!(l.kind, LineKind::Removed);
            assert_eq!(r.kind, LineKind::Added);
            assert_eq!(l.content, "b");
            assert_eq!(r.content, "b");
            assert_eq!(rebuild_new(&rows), lines_of(new));
            assert_eq!(rebuild_old(&rows), lines_of(old));
            assert_invariants(&rows, false);
        }

        // 两侧终结状态一致：完全相同 → 零差异
        assert_eq!(compute_stats(&diff("a\nb", "a\nb")), (0, 0));
        assert_eq!(compute_stats(&diff("a\nb\n", "a\nb\n")), (0, 0));

        // 与真实编辑叠加：末行未终结 -> 追加一行并终结，-1/+2（同 git）
        assert_eq!(compute_stats(&diff("a\nb", "a\nb\nc\n")), (2, 1));
        // 空文件 -> 单个空行
        assert_eq!(compute_stats(&diff("", "\n")), (1, 0));
    }

    #[test]
    fn whitespace_option() {
        let old = "fn f() {\n    return 1;\n}\n";
        let new = "fn f() {\n\treturn 1;   \n}\n";
        // 关闭 ignore_whitespace：return 行是修改对
        let rows = diff(old, new);
        assert_eq!(compute_change_row_indices(&rows), vec![1]);
        assert_eq!(compute_stats(&rows), (1, 1));

        // 开启：全为上下文行，且保留两侧原文
        let rows = diff_strings(
            old,
            new,
            &DiffOptions {
                ignore_whitespace: true,
                max_rows: 0,
            },
        );
        assert!(compute_change_row_indices(&rows).is_empty());
        assert_eq!(compute_stats(&rows), (0, 0));
        assert_eq!(rebuild_new(&rows), lines_of(new));
        assert_eq!(rebuild_old(&rows), lines_of(old));
        let (Some(l), Some(r)) = (&rows[1].left, &rows[1].right) else {
            panic!("row 1 应为上下文行");
        };
        assert_eq!(l.content, "    return 1;");
        assert_eq!(r.content, "\treturn 1;   ");

        // 内部空白折叠：仅空白差异的行视为相同
        let rows = diff_strings(
            "  hello   world  \n",
            "hello world\n",
            &DiffOptions {
                ignore_whitespace: true,
                max_rows: 0,
            },
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(compute_stats(&rows), (0, 0));
    }

    #[test]
    fn max_rows_truncates() {
        let old = "1\n2\n3\n4\n5\n";
        let new = "1\n2\n3\n4\n5\n6\n7\n";
        let full = diff(old, new);
        assert_eq!(full.len(), 7);
        let cut = diff_strings(
            old,
            new,
            &DiffOptions {
                max_rows: 3,
                ..DiffOptions::default()
            },
        );
        assert_eq!(cut.len(), 3);
        fn key(c: Option<&crate::types::RowCell>) -> (LineKind, Option<u32>, &str) {
            c.map(|c| (c.kind, c.lineno, c.content.as_str()))
                .unwrap_or((LineKind::Context, None, ""))
        }
        for i in 0..3 {
            assert_eq!(key(cut[i].left.as_ref()), key(full[i].left.as_ref()));
            assert_eq!(key(cut[i].right.as_ref()), key(full[i].right.as_ref()));
        }
    }

    /// 从 `git diff --no-index` 输出解析 +/- 行（多重集）。
    ///
    /// 以 `'\n'` 显式切分（而非 `str::lines`，后者会把行尾 `'\r'` 连同
    /// `'\n'` 一起剥掉，导致 CRLF 用例无法逐字节比较）。
    fn git_changed_lines(stdout: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut in_hunk = false;
        for line in stdout.split('\n') {
            if line.starts_with("@@") {
                in_hunk = true;
                continue;
            }
            if !in_hunk || line.starts_with('\\') {
                continue; // 头部信息 / "\ No newline at end of file"
            }
            if let Some(rest) = line.strip_prefix('+') {
                out.push(format!("+{rest}"));
            } else if let Some(rest) = line.strip_prefix('-') {
                out.push(format!("-{rest}"));
            }
        }
        out
    }

    /// 本引擎的行分类（+/- 行多重集）。
    fn my_changed_lines(rows: &[AlignedRow]) -> Vec<String> {
        let mut out = Vec::new();
        for row in rows {
            if row
                .left
                .as_ref()
                .is_some_and(|c| c.kind == LineKind::Removed)
            {
                out.push(format!("-{}", row.left.as_ref().map(|c| &c.content).unwrap()));
            }
            if row
                .right
                .as_ref()
                .is_some_and(|c| c.kind == LineKind::Added)
            {
                out.push(format!("+{}", row.right.as_ref().map(|c| &c.content).unwrap()));
            }
        }
        out
    }

    /// git 等价性抽查：非平凡用例（典型编辑 / 块移动与旋转 / CRLF 翻转 /
    /// 末行换行终结符变化）的行分类多重集应与 git 一致。
    ///
    /// 环境中没有 git 时跳过（开发环境已验证通过）。
    #[test]
    fn git_equivalence_spot_check() {
        let git_ok = std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !git_ok {
            eprintln!("跳过：环境中没有可用的 git");
            return;
        }

        let old2: String = (1..=20).map(|i| format!("line {i:02}\n")).collect();
        let new2_lines: Vec<String> = (1..=4)
            .chain(9..=20)
            .map(|i| format!("line {i:02}"))
            .chain(["extra one".to_string(), "extra two".to_string()])
            .collect();
        let new2 = format!("{}\n", new2_lines.join("\n"));

        // 100 行旋转（首行移到末尾）：git 为 -1/+1，本引擎不应整体重写
        let rot: Vec<String> = (1..=100).map(|i| format!("line {i:03}")).collect();
        let rot_old = format!("{}\n", rot.join("\n"));
        let rot_new = format!("{}\n{}\n", rot[1..].join("\n"), rot[0]);

        let cases: Vec<(&str, &str)> = vec![
            // 1) 典型代码编辑：修改一行 + 追加一行
            (
                "fn main() {\n    let a = 1;\n    let b = 2;\n    println!(\"{} {}\", a, b);\n    let c = 3;\n    process(a);\n}\n",
                "fn main() {\n    let a = 1;\n    let b = 2;\n    println!(\"{} / {}\", a, b);\n    let c = 3;\n    process(a);\n    process(b);\n}\n",
            ),
            // 2) 中部删除一段 + 末尾追加
            (&old2, &new2),
            // 3) 重复结构（空行 / 花括号）中的单行修改
            (
                "fn a() {\n    1\n}\n\nfn b() {\n    2\n}\n\nfn c() {\n    3\n}\n",
                "fn a() {\n    1\n}\n\nfn b() {\n    two\n}\n\nfn c() {\n    3\n}\n",
            ),
            // 4) 块移动 / 交错重排（评分并列锚点的最小 diff）
            (
                "P1\nP2\nP3\nA1\nA2\nA3\nA4\n",
                "A1\nA2\nA3\nA4\nP1\nP2\nP3\n",
            ),
            (
                "x1\nm1\nm2\nx2\nx3\nn1\nn2\nx4\n",
                "x1\nx2\nn1\nn2\nx3\nm1\nm2\nx4\n",
            ),
            // 5) 100 行旋转
            (&rot_old, &rot_new),
            // 6) 整文件行尾风格翻转（CRLF -> LF）
            ("a\r\nb\r\nc\r\n", "a\nb\nc\n"),
            // 7) 末行换行终结符变化（\ No newline at end of file）
            ("a\nb", "a\nb\n"),
        ];

        for (old, new) in cases {
            let dir = tempfile::tempdir().expect("创建临时目录失败");
            let p_old = dir.path().join("a.txt");
            let p_new = dir.path().join("b.txt");
            std::fs::write(&p_old, old).expect("写入临时文件失败");
            std::fs::write(&p_new, new).expect("写入临时文件失败");

            let output = std::process::Command::new("git")
                .args([
                    "-c",
                    "core.autocrlf=false",
                    "-c",
                    "diff.algorithm=histogram",
                    "diff",
                    "--no-index",
                    "--unified=0",
                ])
                .arg(&p_old)
                .arg(&p_new)
                .output()
                .expect("执行 git diff 失败");
            assert!(
                output.status.code() == Some(1),
                "git diff 应以 1 退出（存在差异）"
            );
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

            let mut mine = my_changed_lines(&diff(old, new));
            let mut theirs = git_changed_lines(&stdout);
            mine.sort();
            theirs.sort();
            assert_eq!(
                mine, theirs,
                "行分类与 git 不一致:\nold={old:?}\nnew={new:?}\ngit 输出:\n{stdout}"
            );
        }
    }

    #[test]
    fn periodic_content_smoke() {
        // 周期性重复 + 首尾各异（阻止公共前后缀裁剪）：所有候选评分并列且
        // 不同偏移的 run 相互交叠，验证扩展预算约束下结果仍正确可重建
        // （每个 run 至多完整扩展一次，近线性，不做时间断言）。
        let block = "a\nb".repeat(10_000);
        let old = format!("X\n{block}\nY\n");
        let new = format!("Z\n{block}\nW\n");
        let rows = diff(&old, &new);
        assert_eq!(rebuild_new(&rows), lines_of(&new));
        assert_eq!(rebuild_old(&rows), lines_of(&old));
        assert_invariants(&rows, false);
        // 仅首尾两行替换，中间周期块全部保留
        assert_eq!(compute_stats(&rows), (2, 2));
    }

    /// 性能冒烟：10_000 行、散布修改/插入/删除。不做硬性时间断言，
    /// 仅打印耗时（见任务说明）。
    #[test]
    fn perf_smoke_10k_lines() {
        let old: Vec<String> = (0..10_000)
            .map(|i| format!("line {i}: the quick brown fox jumps"))
            .collect();
        let mut new: Vec<String> = Vec::with_capacity(old.len() + 64);
        for (i, line) in old.iter().enumerate() {
            if i % 500 == 250 {
                new.push(format!("inserted {i}"));
            }
            if i % 700 == 350 {
                continue; // 删除
            }
            if i % 167 == 83 {
                new.push(format!("line {i}: EDITED {}", i * 3));
            } else {
                new.push(line.clone());
            }
        }
        let old_s = format!("{}\n", old.join("\n"));
        let new_s = format!("{}\n", new.join("\n"));

        let start = std::time::Instant::now();
        let rows = diff_strings(&old_s, &new_s, &DiffOptions::default());
        let elapsed = start.elapsed();
        eprintln!(
            "perf_smoke_10k_lines: {} 行 -> {} 行, {} rows, 耗时 {elapsed:?}",
            old.len(),
            new.len(),
            rows.len()
        );

        // 正确性与不变量不受性能保护影响
        assert_eq!(rebuild_new(&rows), new);
        assert_eq!(rebuild_old(&rows), old);
        assert_invariants(&rows, false);
        assert!(!compute_change_row_indices(&rows).is_empty());
    }
}
