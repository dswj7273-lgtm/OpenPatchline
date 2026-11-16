//! Phase 3 行对齐：将 Phase 1 的原始操作序列（`RawOp`）转换为左右等长、
//! 可直接按行渲染的 [`AlignedRow`] 列表。
//!
//! 与 docs/05 §6 的差异（按任务书要求，任务书优先）：变更块内第 i 个
//! Removed 行与第 i 个 Added 行**同行配对**（左 Removed / 右 Added），
//! 使字符级 diff 能像 IntelliJ 一样高亮同一行内的左右变化；多余行再以
//! 单侧 `None` 占位——先多余 Removed，后多余 Added。

use super::RawOp;
use crate::types::{AlignedRow, LineKind, RowCell};

/// 将原始操作序列对齐为行列表。
///
/// - `Equal` → 上下文行（两侧均 Some，行号取 old/new 实际行号）；
/// - 连续的 `Remove`/`Add` 构成一个变更块：块内按顺序收集两侧行，
///   前 `min(删除数, 新增数)` 行两两配对，随后是多余 Removed、多余 Added；
/// - v1 保留全部上下文行（不折叠），长度交给前端虚拟列表。
pub(super) fn align_ops(ops: &[RawOp], old_lines: &[&str], new_lines: &[&str]) -> Vec<AlignedRow> {
    let mut rows = Vec::new();
    let mut i = 0;
    while i < ops.len() {
        match &ops[i] {
            RawOp::Equal {
                old_start,
                new_start,
                len,
            } => {
                for k in 0..*len {
                    rows.push(AlignedRow {
                        left: Some(cell(old_start + k, old_lines, LineKind::Context)),
                        right: Some(cell(new_start + k, new_lines, LineKind::Context)),
                    });
                }
                i += 1;
            }
            RawOp::Remove { .. } | RawOp::Add { .. } => {
                // 收集同一变更块内的所有 Remove/Add（各自保持行序）
                let mut removed: Vec<usize> = Vec::new();
                let mut added: Vec<usize> = Vec::new();
                while i < ops.len() {
                    match &ops[i] {
                        RawOp::Remove { old_start, len } => {
                            removed.extend(*old_start..*old_start + *len);
                        }
                        RawOp::Add { new_start, len } => {
                            added.extend(*new_start..*new_start + *len);
                        }
                        RawOp::Equal { .. } => break,
                    }
                    i += 1;
                }
                // 先配对（字符级 diff 的作用对象），再多余 Removed，再多余 Added
                let paired = removed.len().min(added.len());
                for k in 0..paired {
                    rows.push(AlignedRow {
                        left: Some(cell(removed[k], old_lines, LineKind::Removed)),
                        right: Some(cell(added[k], new_lines, LineKind::Added)),
                    });
                }
                for &oi in &removed[paired..] {
                    rows.push(AlignedRow {
                        left: Some(cell(oi, old_lines, LineKind::Removed)),
                        right: None,
                    });
                }
                for &ni in &added[paired..] {
                    rows.push(AlignedRow {
                        left: None,
                        right: Some(cell(ni, new_lines, LineKind::Added)),
                    });
                }
            }
        }
    }
    rows
}

/// 构造行单元格（行号 1 起，内容为该侧原文）。
fn cell(idx: usize, lines: &[&str], kind: LineKind) -> RowCell {
    RowCell {
        lineno: Some(u32::try_from(idx + 1).unwrap_or(u32::MAX)),
        content: lines[idx].to_string(),
        kind,
        char_ranges: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_then_excess_removed() {
        // Remove(2) + Add(1)：1 个修改对 + 1 个多余 Removed
        let ops = vec![
            RawOp::Remove {
                old_start: 0,
                len: 2,
            },
            RawOp::Add {
                new_start: 0,
                len: 1,
            },
        ];
        let rows = align_ops(&ops, &["o0", "o1"], &["n0"]);
        assert_eq!(rows.len(), 2);
        let (Some(l), Some(r)) = (&rows[0].left, &rows[0].right) else {
            panic!("row 0 应为修改对");
        };
        assert_eq!(l.kind, LineKind::Removed);
        assert_eq!(r.kind, LineKind::Added);
        assert_eq!(l.content, "o0");
        assert_eq!(r.content, "n0");
        assert_eq!(l.lineno, Some(1));
        assert_eq!(r.lineno, Some(1));
        // 多余 Removed：左 Some / 右 None
        assert_eq!(
            rows[1].left.as_ref().map(|c| c.content.as_str()),
            Some("o1")
        );
        assert!(rows[1].right.is_none());
    }

    #[test]
    fn excess_added_after_pairs() {
        // Add 在前、Remove 在后（op 顺序不影响配对结果）：
        // 2 删除 + 3 新增 → 2 对 + 1 个多余 Added
        let ops = vec![
            RawOp::Add {
                new_start: 0,
                len: 3,
            },
            RawOp::Remove {
                old_start: 0,
                len: 2,
            },
        ];
        let rows = align_ops(&ops, &["o0", "o1"], &["n0", "n1", "n2"]);
        assert_eq!(rows.len(), 3);
        for row in &rows[..2] {
            assert!(row.left.is_some() && row.right.is_some());
        }
        // 多余 Added 排在最后：左 None / 右 Some
        assert!(rows[2].left.is_none());
        assert_eq!(
            rows[2].right.as_ref().map(|c| c.content.as_str()),
            Some("n2")
        );
        // 行号保持严格递增
        let olds: Vec<u32> = rows
            .iter()
            .filter_map(|r| r.left.as_ref().and_then(|c| c.lineno))
            .collect();
        let news: Vec<u32> = rows
            .iter()
            .filter_map(|r| r.right.as_ref().and_then(|c| c.lineno))
            .collect();
        assert_eq!(olds, vec![1, 2]);
        assert_eq!(news, vec![1, 2, 3]);
    }

    #[test]
    fn adjacent_ops_in_one_block() {
        // 无 Equal 分隔的 Remove/Add/Remove 仍属同一变更块
        let ops = vec![
            RawOp::Remove {
                old_start: 0,
                len: 1,
            },
            RawOp::Add {
                new_start: 0,
                len: 1,
            },
            RawOp::Remove {
                old_start: 1,
                len: 1,
            },
        ];
        let rows = align_ops(&ops, &["o0", "o1"], &["n0"]);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].left.is_some() && rows[0].right.is_some());
        assert!(rows[1].left.is_some() && rows[1].right.is_none());
        assert_eq!(
            rows[1].left.as_ref().map(|c| c.content.as_str()),
            Some("o1")
        );
    }
}
