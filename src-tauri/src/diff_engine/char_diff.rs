//! Phase 4 字符级 diff：对“相似”的 Removed/Added 修改对计算行内高亮区间
//! （docs/05 §7）。区间偏移为**字符偏移**（Unicode scalar，[start, end)），
//! 与 [`crate::types::CharRange`] 契约一致；比较复用 [`super::myers_ops`]。

use super::RawOp;
use crate::types::{AlignedRow, CharRange, LineKind};

/// 参与字符级 diff 的最大行长（字符数）。
const MAX_CHAR_DIFF_LEN: usize = 200;
/// 长度相似度阈值：|len_a - len_b| / max > 0.6 视为不相似。
const MAX_LEN_RATIO: f64 = 0.6;

/// 判断一对 Removed/Added 行是否值得做字符级 diff（廉价的相似度门控）。
///
/// 条件（任务书指定的启发式）：
/// 1. 两行均非空且长度（字符数）≤ [`MAX_CHAR_DIFF_LEN`]；
/// 2. `|len_a - len_b| / max <= 0.6`（common-ratio >= 0.4 的长度代理）；
/// 3. 首 4 或末 4 字符中至少有一个公共字符。
pub(super) fn should_highlight(old: &str, new: &str) -> bool {
    // UTF-8 每字符至多 4 字节：字节数超限则字符数必超限，免去整行扫描
    if old.len() > MAX_CHAR_DIFF_LEN * 4 || new.len() > MAX_CHAR_DIFF_LEN * 4 {
        return false;
    }
    let (oc, nc) = (old.chars().count(), new.chars().count());
    if oc == 0 || nc == 0 || oc > MAX_CHAR_DIFF_LEN || nc > MAX_CHAR_DIFF_LEN {
        return false;
    }
    // 此处 oc/nc 均 <= MAX_CHAR_DIFF_LEN，as f64 无精度损失
    if oc.abs_diff(nc) as f64 / oc.max(nc) as f64 > MAX_LEN_RATIO {
        return false;
    }
    let oh: Vec<char> = old.chars().take(4).collect();
    let ot: Vec<char> = old.chars().rev().take(4).collect();
    let nh: Vec<char> = new.chars().take(4).collect();
    let nt: Vec<char> = new.chars().rev().take(4).collect();
    oh.iter().any(|&c| nh.contains(&c)) || ot.iter().any(|&c| nt.contains(&c))
}

/// 计算两行内容的字符级差异区间（字符偏移，[start, end)）。
///
/// 返回 `(old 侧高亮区间, new 侧高亮区间)`；完全相同时两侧均为空。
pub(super) fn char_diff(old: &str, new: &str) -> (Vec<CharRange>, Vec<CharRange>) {
    let oc: Vec<char> = old.chars().collect();
    let nc: Vec<char> = new.chars().collect();
    let mut ops = Vec::new();
    super::myers_ops(&oc, &nc, 0, 0, &mut ops);
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for op in ops {
        match op {
            RawOp::Equal { .. } => {}
            RawOp::Remove { old_start, len } => left.push(CharRange {
                start: old_start,
                end: old_start + len,
            }),
            RawOp::Add { new_start, len } => right.push(CharRange {
                start: new_start,
                end: new_start + len,
            }),
        }
    }
    (left, right)
}

/// 为所有修改对行（左 Removed + 右 Added）填充字符级高亮区间。
///
/// 不满足门控（过长 / 不相似）的修改对保持空 `char_ranges`。
pub(super) fn highlight_rows(rows: &mut [AlignedRow]) {
    for row in rows.iter_mut() {
        let (Some(l), Some(r)) = (row.left.as_mut(), row.right.as_mut()) else {
            continue;
        };
        if l.kind != LineKind::Removed || r.kind != LineKind::Added {
            continue;
        }
        if !should_highlight(&l.content, &r.content) {
            continue;
        }
        let (left_ranges, right_ranges) = char_diff(&l.content, &r.content);
        l.char_ranges = left_ranges;
        r.char_ranges = right_ranges;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff_engine::{DiffOptions, diff_strings};

    fn same(ranges: &[CharRange], expect: &[(usize, usize)]) -> bool {
        ranges.len() == expect.len()
            && ranges
                .iter()
                .zip(expect)
                .all(|(r, &(s, e))| r.start == s && r.end == e)
    }

    #[test]
    fn hello_world_small_ranges() {
        // "e"->"a" 与末尾 "!"：区间应非常小
        let (l, r) = char_diff("hello world", "hallo world!");
        assert!(
            same(&l, &[(1, 2)]),
            "左侧区间应只覆盖 'e': {:?}",
            (l.iter().map(|c| (c.start, c.end))).collect::<Vec<_>>()
        );
        assert!(
            same(&r, &[(1, 2), (11, 12)]),
            "右侧区间应覆盖 'a' 与 '!': {:?}",
            (r.iter().map(|c| (c.start, c.end))).collect::<Vec<_>>()
        );
    }

    #[test]
    fn gate_accepts_and_rejects() {
        assert!(should_highlight("hello world", "hallo world!"));
        // 完全不同：首/末 4 字符无公共字符
        assert!(!should_highlight("aaaaaa", "zzzzzz"));
        // 长度差异过大
        assert!(!should_highlight("abc", "0123456789abcdefghij"));
        // 超长行不做字符级 diff
        let long = "x".repeat(MAX_CHAR_DIFF_LEN + 1);
        assert!(!should_highlight(&long, &long));
        // 空行
        assert!(!should_highlight("", "x"));
    }

    #[test]
    fn totally_different_no_blowup() {
        // 直接调用（绕过门控）：完全不同的行 → 整行区间，不崩溃
        let (l, r) = char_diff("abc", "xyz");
        assert!(same(&l, &[(0, 3)]));
        assert!(same(&r, &[(0, 3)]));

        // 经由完整管线：门控拒绝 → 修改对区间为空
        let rows = diff_strings("aaaaaa\n", "zzzzzz\n", &DiffOptions::default());
        assert_eq!(rows.len(), 1);
        let (Some(l), Some(r)) = (&rows[0].left, &rows[0].right) else {
            panic!("应为修改对");
        };
        assert_eq!(l.kind, LineKind::Removed);
        assert_eq!(r.kind, LineKind::Added);
        assert!(l.char_ranges.is_empty());
        assert!(r.char_ranges.is_empty());
    }

    #[test]
    fn paired_rows_get_highlighted() {
        // 管线内：修改对两侧填充字符区间
        let rows = diff_strings("hello world\n", "hallo world!\n", &DiffOptions::default());
        assert_eq!(rows.len(), 1);
        let (Some(l), Some(r)) = (&rows[0].left, &rows[0].right) else {
            panic!("应为修改对");
        };
        assert!(same(&l.char_ranges, &[(1, 2)]));
        assert!(same(&r.char_ranges, &[(1, 2), (11, 12)]));
    }

    #[test]
    fn unicode_char_offsets() {
        // 区间按字符（而非字节）计：在 2 个多字节字符后插入 1 个字符
        let (l, r) = char_diff("你好世界", "你好啊世界");
        assert!(l.is_empty());
        assert!(same(&r, &[(2, 3)]));
    }
}
