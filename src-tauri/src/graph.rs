//! Commit Graph Engine：泳道（Lane）分配与连线计算（docs/04-git-engine.md §5）。
//!
//! [`GraphState`] 是增量状态：跨分页持久（每仓库一个实例），保证泳道与颜色
//! 在页与页之间连续。算法见 docs/04 §5.3。
//!
//! 过滤视图（author/query）下被过滤掉的父提交永远不会到达：为其保留的
//! 槽位使用“弱预留”（[`LaneSlot::Tentative`]），可被后续无预留到达的提交
//! 接管为延续线（与 `git log --graph --author=…` 的折叠语义一致），避免
//! 泳道数随显示行数无界增长。

use std::collections::HashSet;

use crate::types::{CommitGraphRow, CommitNode, Connection, ConnectionKind};

/// 泳道调色板大小（0..LANE_COLORS 对应 CSS `--graph-lane-0..7`）。
pub const LANE_COLORS: usize = 8;

/// 泳道槽位状态。
#[derive(Debug, PartialEq, Eq)]
enum LaneSlot {
    /// 空槽，可复用。
    Free,
    /// 强预留：等待的父提交在当前页内，本页内必然到达并被精确消费。
    Reserved(String),
    /// 弱预留：等待的父提交不在当前页——正常分页时会在后续页到达并被
    /// 精确消费；过滤视图（author/query）下可能永远不会到达。弱预留槽
    /// 可被“无预留到达”的提交接管为延续线。未过滤的连续遍历中非根
    /// 提交必有子提交为其预留（接管路径不会触发），该回收机制只影响
    /// 过滤视图。
    Tentative(String),
}

impl LaneSlot {
    /// 槽位等待的提交 id；空槽返回 None。
    fn waiting_id(&self) -> Option<&str> {
        match self {
            LaneSlot::Free => None,
            LaneSlot::Reserved(id) | LaneSlot::Tentative(id) => Some(id),
        }
    }
}

/// 泳道布局增量状态。
#[derive(Default)]
pub struct GraphState {
    /// 每个泳道槽位：预留（强/弱）表示等待被消费的提交，Free 表示空槽可复用。
    lanes: Vec<LaneSlot>,
    /// 每条泳道的颜色索引（占用时按 `lane_index % LANE_COLORS` 确定，整条分支线
    /// 保持不变；槽位空出时置 None，被新分支线复用时重新确定）。
    lane_colors: Vec<Option<usize>>,
    /// 上一页最后一行的 `connections_below`：作为下一页首行的 `connections_above`，
    /// 保证跨页 gap 两侧描述完全一致（首页为空）。
    pending_above: Vec<Connection>,
}

impl GraphState {
    /// 创建空的图状态（无活跃泳道）。
    pub fn new() -> Self {
        Self {
            lanes: Vec::new(),
            lane_colors: Vec::new(),
            pending_above: Vec::new(),
        }
    }

    /// 对新一页提交（newest-first，`parent_ids` 已知）计算图行。
    ///
    /// 增量算法（docs/04 §5.3）：
    /// 1. 在 `lanes` 中找预留（强/弱）`commit.id` 的槽位即为其 lane；找不到
    ///    而存在弱预留（悬空延续线，其目标提交可能已被过滤掉）时接管最早
    ///    的弱预留槽；否则取第一个空槽（Free），没有空槽则追加新槽。消费
    ///    时清空该 id 的全部预留槽位（同一提交可能被两个子提交分别预留过）；
    /// 2. 第一个父提交延续当前 lane（Straight）；若其已被其他子提交预留，
    ///    本行 lane 让出并画汇入斜线（MergeIn）；其余父提交：已有预留则保持
    ///    （cross-merge，画汇入斜线），否则占用第一个空槽/新槽（MergeIn）。
    ///    父提交在当前页内作强预留（必然到达）；不在页内作弱预留（跨页到达，
    ///    或被过滤掉而由后续无预留到达的提交接管回收）；
    /// 3. 本行未被消费、继续向下延伸的泳道各发一条穿越 Straight；
    /// 4. `connections_above` 与上一行 `connections_below` 描述同一 gap，只计算
    ///    一次、两处共享；首页首行上方为空，跨页由持久状态携带；
    /// 5. 页内不截断末尾空槽（`lane_count` 随 lanes.len() 自然增长）；页尾压缩
    ///    末尾连续空槽，但压缩下界不低于 `pending_above` 引用的最大泳道 +1，
    ///    保证下一页首行的 `lane_count` 覆盖其 `connections_above` 的全部引用。
    ///
    /// 返回值中 `commit.lane`/`commit.lane_color` 会被回填为该行的
    /// `lane_index`/`color_index`。状态保留在 self 中，下一页继续。
    pub fn compute_graph_rows(&mut self, commits: Vec<CommitNode>) -> Vec<CommitGraphRow> {
        let carried_above = std::mem::take(&mut self.pending_above);
        // 当前页 id 集合：页内必然到达的父提交作强预留；不在页内的父提交
        // 只能弱预留（可能跨页到达，也可能被过滤掉）。
        let page_ids: HashSet<String> = commits.iter().map(|c| c.id.clone()).collect();
        let mut rows: Vec<CommitGraphRow> = Vec::with_capacity(commits.len());

        for mut commit in commits {
            // 1. 定位本提交泳道：优先消费已有（强/弱）预留；无预留到达时若
            //    存在弱预留（悬空延续线）则接管最早的弱预留槽；否则第一个
            //    空槽 / 追加新槽。
            let mut takeover: Option<usize> = None;
            let lane_index = match self.find_reserved(&commit.id) {
                Some(i) => i,
                None => match self.first_tentative() {
                    Some(i) => {
                        takeover = Some(i);
                        i
                    }
                    None => self.acquire_free(),
                },
            };
            // 颜色沿泳道继承：消费前读取该分支线自分配起保持的颜色。
            let color_index = self.color_of(lane_index);

            // 2. 消费预留：清掉该 id 的全部槽位（含重复预留，首个即正式泳道）；
            //    接管弱预留时一并释放被接管的槽位。
            for (i, slot) in self.lanes.iter_mut().enumerate() {
                if slot.waiting_id() == Some(commit.id.as_str()) || takeover == Some(i) {
                    *slot = LaneSlot::Free;
                    if let Some(c) = self.lane_colors.get_mut(i) {
                        *c = None;
                    }
                }
            }

            // 3. 父提交槽位分配 + 本行向下（更旧方向）的连线段。
            let mut below: Vec<Connection> = Vec::new();
            let parents = &commit.parent_ids;
            let first_parent = parents.first().map(|s| s.as_str());
            if let Some(p0) = first_parent {
                if let Some(k) = self.find_reserved(p0) {
                    // 第一父已被其他子提交预留（second-child 汇入）：本行 lane
                    // 让出，画一条汇入既有预留泳道的斜线。
                    let color = self.color_of(k);
                    push_conn(
                        &mut below,
                        Connection {
                            from_lane: lane_index,
                            to_lane: k,
                            color_index: color,
                            kind: ConnectionKind::MergeIn,
                        },
                    );
                } else {
                    // 第一父延续当前泳道：竖线。父在页内作强预留，不在页内
                    // （跨页或被过滤）作弱预留。
                    self.occupy(lane_index, p0, !page_ids.contains(p0));
                    let color = self.color_of(lane_index);
                    below.push(Connection {
                        from_lane: lane_index,
                        to_lane: lane_index,
                        color_index: color,
                        kind: ConnectionKind::Straight,
                    });
                }
            }
            // 本行为额外父新开辟的泳道：其连线由 MergeIn 斜线起步，穿越竖线
            // 不应重复覆盖（既有预留的 cross-merge 泳道则两者并存）。
            let mut fresh_lanes: Vec<usize> = Vec::new();
            for p in parents.iter().skip(1) {
                // 与第一父重复的父项：线段已由第一父覆盖，跳过。
                if Some(p.as_str()) == first_parent {
                    continue;
                }
                match self.find_reserved(p) {
                    // cross-merge：父已有预留，保持不动。
                    Some(k) => {
                        let color = self.color_of(k);
                        push_conn(
                            &mut below,
                            Connection {
                                from_lane: lane_index,
                                to_lane: k,
                                color_index: color,
                                kind: ConnectionKind::MergeIn,
                            },
                        );
                    }
                    None => {
                        let k = self.acquire_free();
                        self.occupy(k, p, !page_ids.contains(p.as_str()));
                        let color = self.color_of(k);
                        if k == lane_index {
                            // 退化情形：第一父汇入他处后本行 lane 空出、恰好被
                            // 该父复用，等价于竖线延续。
                            below.push(Connection {
                                from_lane: k,
                                to_lane: k,
                                color_index: color,
                                kind: ConnectionKind::Straight,
                            });
                        } else {
                            fresh_lanes.push(k);
                            push_conn(
                                &mut below,
                                Connection {
                                    from_lane: lane_index,
                                    to_lane: k,
                                    color_index: color,
                                    kind: ConnectionKind::MergeIn,
                                },
                            );
                        }
                    }
                }
            }

            // 4. 穿越泳道：本行未被消费、仍被占据的槽位各发一条竖线。
            for i in 0..self.lanes.len() {
                if i == lane_index || fresh_lanes.contains(&i) {
                    continue; // 本提交泳道/新开泳道已由父连线覆盖
                }
                if self.is_occupied(i) {
                    let color = self.color_of(i);
                    below.push(Connection {
                        from_lane: i,
                        to_lane: i,
                        color_index: color,
                        kind: ConnectionKind::Straight,
                    });
                }
            }

            // 5. 组装行（lane_count 取处理完该行后的槽位总数，页内不截断）。
            let lane_count = self.lanes.len();
            commit.lane = lane_index;
            commit.lane_color = color_index;
            rows.push(CommitGraphRow {
                commit,
                lane_index,
                lane_count,
                color_index,
                connections_above: Vec::new(),
                connections_below: below,
            });
        }

        // connections_above：与上一行之间的同一 gap 只计算一次（即上一行的
        // below），首行取跨页携带的 pending_above（首页为空）。
        let mut above = carried_above;
        for row in &mut rows {
            let next = row.connections_below.clone();
            row.connections_above = std::mem::replace(&mut above, next);
        }

        // 剩余 above 即本页最后一个 gap（空页时为原携带状态），供下一页使用。
        self.pending_above = above;

        // 页尾压缩末尾连续空槽（不影响任何已占据槽位的下标）；压缩下界不低于
        // pending_above 引用的最大泳道 +1：该 gap 会成为下一页首行的
        // connections_above，若其引用的泳道被压缩掉，下一页首行的 lane_count
        // 将小于连线引用的下标（违反 lane_count 语义，且与单次全量计算的
        // 结果不一致）。
        let min_len = self
            .pending_above
            .iter()
            .map(|c| c.from_lane.max(c.to_lane) + 1)
            .max()
            .unwrap_or(0);
        while self.lanes.len() > min_len && matches!(self.lanes.last(), Some(LaneSlot::Free)) {
            self.lanes.pop();
            self.lane_colors.pop();
        }
        rows
    }

    /// 找到预留（强或弱）`id` 的第一个槽位下标。
    fn find_reserved(&self, id: &str) -> Option<usize> {
        self.lanes
            .iter()
            .position(|s| s.waiting_id() == Some(id))
    }

    /// 找到最早的弱预留（悬空延续线）槽位下标。
    fn first_tentative(&self) -> Option<usize> {
        self.lanes
            .iter()
            .position(|s| matches!(s, LaneSlot::Tentative(_)))
    }

    /// 取第一个空槽；没有空槽则追加新槽。返回槽位下标（不写入占用者）。
    fn acquire_free(&mut self) -> usize {
        match self.lanes.iter().position(|s| matches!(s, LaneSlot::Free)) {
            Some(i) => i,
            None => {
                self.lanes.push(LaneSlot::Free);
                self.lane_colors.push(None);
                self.lanes.len() - 1
            }
        }
    }

    /// 占用槽位 `lane` 等待 `id` 出现，并（重新）确定该泳道颜色。
    /// `tentative`：父提交不在当前页（跨页到达或被过滤）时为真。
    fn occupy(&mut self, lane: usize, id: &str, tentative: bool) {
        self.lanes[lane] = if tentative {
            LaneSlot::Tentative(id.to_string())
        } else {
            LaneSlot::Reserved(id.to_string())
        };
        if let Some(c) = self.lane_colors.get_mut(lane) {
            *c = Some(lane % LANE_COLORS);
        }
    }

    /// 槽位是否被预留占据（强或弱）。
    fn is_occupied(&self, lane: usize) -> bool {
        matches!(
            self.lanes.get(lane),
            Some(LaneSlot::Reserved(_) | LaneSlot::Tentative(_))
        )
    }

    /// 读取泳道颜色；未记录时回退到 `lane % LANE_COLORS`。
    fn color_of(&self, lane: usize) -> usize {
        match self.lane_colors.get(lane) {
            Some(Some(c)) => *c,
            _ => lane % LANE_COLORS,
        }
    }
}

/// 追加连线段，跳过完全重复的段（如父列表中重复出现的父项）。
fn push_conn(list: &mut Vec<Connection>, conn: Connection) {
    let duplicated = list.iter().any(|e| {
        e.from_lane == conn.from_lane
            && e.to_lane == conn.to_lane
            && e.color_index == conn.color_index
            && same_kind(&e.kind, &conn.kind)
    });
    if !duplicated {
        list.push(conn);
    }
}

/// [`ConnectionKind`] 未派生 PartialEq 的等值比较。
fn same_kind(a: &ConnectionKind, b: &ConnectionKind) -> bool {
    matches!(
        (a, b),
        (ConnectionKind::Straight, ConnectionKind::Straight)
            | (ConnectionKind::BranchOut, ConnectionKind::BranchOut)
            | (ConnectionKind::MergeIn, ConnectionKind::MergeIn)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Straight 段的 kind 编码。
    const S: u8 = 0;
    /// MergeIn 段的 kind 编码。
    const M: u8 = 2;

    fn node(id: &str, parents: &[&str]) -> CommitNode {
        CommitNode {
            id: id.to_string(),
            short_id: id.chars().take(7).collect(),
            message: format!("commit {id}"),
            author_name: "tester".to_string(),
            author_email: "tester@example.com".to_string(),
            timestamp: 0,
            parent_ids: parents.iter().map(|s| s.to_string()).collect(),
            refs: Vec::new(),
            lane: 0,
            lane_color: 0,
        }
    }

    fn kind_code(kind: &ConnectionKind) -> u8 {
        match kind {
            ConnectionKind::Straight => S,
            ConnectionKind::BranchOut => 1,
            ConnectionKind::MergeIn => M,
        }
    }

    /// 展开为 (from_lane, to_lane, color_index, kind) 元组便于断言。
    fn segs(row: &CommitGraphRow, below: bool) -> Vec<(usize, usize, usize, u8)> {
        let list = if below {
            &row.connections_below
        } else {
            &row.connections_above
        };
        list.iter()
            .map(|c| (c.from_lane, c.to_lane, c.color_index, kind_code(&c.kind)))
            .collect()
    }

    #[test]
    fn linear_history_uses_single_lane() {
        let mut g = GraphState::new();
        let rows = g.compute_graph_rows(vec![
            node("c4", &["c3"]),
            node("c3", &["c2"]),
            node("c2", &["c1"]),
            node("c1", &["c0"]),
            node("c0", &[]),
        ]);
        assert_eq!(rows.len(), 5);
        for (i, row) in rows.iter().enumerate() {
            assert_eq!(row.lane_index, 0);
            assert_eq!(row.lane_count, 1);
            assert_eq!(row.color_index, 0);
            assert_eq!(row.commit.lane, 0);
            assert_eq!(row.commit.lane_color, 0);
            if i == 0 {
                assert!(row.connections_above.is_empty());
            } else {
                assert_eq!(segs(row, false), vec![(0, 0, 0, S)]);
            }
        }
        for row in &rows[..rows.len() - 1] {
            assert_eq!(segs(row, true), vec![(0, 0, 0, S)]);
        }
        // 根提交释放其泳道：下方无线，页尾压缩后无活跃泳道。
        assert!(rows[4].connections_below.is_empty());
        assert!(g.lanes.is_empty());
    }

    #[test]
    fn feature_branch_and_merge_uses_two_lanes() {
        let mut g = GraphState::new();
        // m = merge(b, f)；b、f 均以 a 为父。
        let rows = g.compute_graph_rows(vec![
            node("m", &["b", "f"]),
            node("b", &["a"]),
            node("f", &["a"]),
            node("a", &[]),
        ]);
        assert_eq!(
            rows.iter().map(|r| r.lane_index).collect::<Vec<_>>(),
            vec![0, 0, 1, 0]
        );
        assert!(rows.iter().all(|r| r.lane_count == 2));

        // 合并行：第一父竖线 + 指向第二父泳道的 MergeIn 斜线。
        assert_eq!(segs(&rows[0], true), vec![(0, 0, 0, S), (0, 1, 1, M)]);
        assert_eq!(segs(&rows[1], true), vec![(0, 0, 0, S), (1, 1, 1, S)]);
        // f 行：父 a 已被 b 预留 → 汇入泳道 0 的斜线；泳道 0 穿越竖线。
        assert_eq!(segs(&rows[2], true), vec![(1, 0, 0, M), (0, 0, 0, S)]);
        assert!(rows[3].connections_below.is_empty());

        // gap 一致性：below[i] 与 above[i+1] 描述同一段。
        for i in 0..rows.len() - 1 {
            assert_eq!(segs(&rows[i], true), segs(&rows[i + 1], false));
        }
    }

    #[test]
    fn octopus_merge_three_parents() {
        let mut g = GraphState::new();
        let rows = g.compute_graph_rows(vec![
            node("m", &["b", "f1", "f2"]),
            node("b", &["a"]),
            node("f1", &["a"]),
            node("f2", &["a"]),
            node("a", &[]),
        ]);
        assert_eq!(
            rows.iter().map(|r| r.lane_index).collect::<Vec<_>>(),
            vec![0, 0, 1, 2, 0]
        );
        assert_eq!(rows[0].lane_count, 3);
        // 三个父：第一父竖线，其余两个各一条 MergeIn 斜线。
        assert_eq!(
            segs(&rows[0], true),
            vec![(0, 0, 0, S), (0, 1, 1, M), (0, 2, 2, M)]
        );
        assert_eq!(
            segs(&rows[1], true),
            vec![(0, 0, 0, S), (1, 1, 1, S), (2, 2, 2, S)]
        );
        // f1 / f2 各自汇入 a 的预留泳道 0。
        assert_eq!(
            segs(&rows[2], true),
            vec![(1, 0, 0, M), (0, 0, 0, S), (2, 2, 2, S)]
        );
        assert_eq!(segs(&rows[3], true), vec![(2, 0, 0, M), (0, 0, 0, S)]);
        assert_eq!(rows[4].lane_index, 0);
        assert!(rows[4].connections_below.is_empty());
    }

    #[test]
    fn criss_cross_merges() {
        let mut g = GraphState::new();
        // m1 = merge(b, c)，m2 = merge(c, b)：互相合并对方的父（criss-cross）。
        let rows = g.compute_graph_rows(vec![
            node("m1", &["b", "c"]),
            node("m2", &["c", "b"]),
            node("c", &["a"]),
            node("b", &["a"]),
            node("a", &[]),
        ]);
        assert_eq!(
            rows.iter().map(|r| r.lane_index).collect::<Vec<_>>(),
            vec![0, 2, 1, 0, 1]
        );
        assert_eq!(segs(&rows[0], true), vec![(0, 0, 0, S), (0, 1, 1, M)]);
        // m2 未被预留（0/1 均被占据）→ 新泳道 2；两个父均已有预留，各自汇入。
        assert_eq!(
            segs(&rows[1], true),
            vec![(2, 1, 1, M), (2, 0, 0, M), (0, 0, 0, S), (1, 1, 1, S)]
        );
        // c：父 a 未被预留，延续自己的泳道 1。
        assert_eq!(segs(&rows[2], true), vec![(1, 1, 1, S), (0, 0, 0, S)]);
        // b：父 a 已被 c 预留于泳道 1 → 右向汇入斜线。
        assert_eq!(segs(&rows[3], true), vec![(0, 1, 1, M), (1, 1, 1, S)]);
        assert_eq!(rows[4].lane_index, 1);
        assert!(rows[4].connections_below.is_empty());
        for i in 0..rows.len() - 1 {
            assert_eq!(segs(&rows[i], true), segs(&rows[i + 1], false));
        }
    }

    /// 跨页的 second-child 汇入：b、c 同为 a 的子提交，m = merge(b, c)。
    /// 第一页后 a、c 均为弱预留；第二页 c 消费自己的弱预留泳道 1，并发现
    /// a 已被 b 预留于泳道 0 而汇入。
    #[test]
    fn second_child_finds_cross_page_reservation() {
        let mut g = GraphState::new();
        let page1 = g.compute_graph_rows(vec![node("m", &["b", "c"]), node("b", &["a"])]);
        assert_eq!(
            page1.iter().map(|r| r.lane_index).collect::<Vec<_>>(),
            vec![0, 0]
        );
        assert_eq!(segs(&page1[0], true), vec![(0, 0, 0, S), (0, 1, 1, M)]);
        assert_eq!(segs(&page1[1], true), vec![(0, 0, 0, S), (1, 1, 1, S)]);

        let page2 = g.compute_graph_rows(vec![node("c", &["a"]), node("a", &[])]);
        assert_eq!(
            page2.iter().map(|r| r.lane_index).collect::<Vec<_>>(),
            vec![1, 0]
        );
        // c 到达：消费泳道 1 的弱预留；父 a 已被 b 预留于泳道 0 → 汇入。
        assert_eq!(segs(&page2[0], true), vec![(1, 0, 0, M), (0, 0, 0, S)]);
        // 跨页 gap 一致：page2 首行 above == page1 末行 below。
        assert_eq!(segs(&page2[0], false), segs(&page1[1], true));
        assert!(page2[1].connections_below.is_empty());
        assert!(g.lanes.is_empty());
    }

    /// 过滤视图（author/query）下被过滤掉的父提交永不到达：其弱预留由后续
    /// 无预留到达的提交接管回收，泳道不随显示行数增长（对应
    /// `git log --graph --author=…` 的单列折叠语义）。
    #[test]
    fn filtered_out_parents_do_not_leak_lanes() {
        let mut g = GraphState::new();
        // 线性历史交替作者：a* 显示，h*（被过滤的父提交）永不出现在任何页。
        let rows = g.compute_graph_rows(vec![
            node("a1", &["h1"]),
            node("a2", &["h2"]),
            node("a3", &["h3"]),
        ]);
        assert_eq!(
            rows.iter().map(|r| r.lane_index).collect::<Vec<_>>(),
            vec![0, 0, 0]
        );
        assert!(rows.iter().all(|r| r.lane_count == 1));
        for row in &rows {
            assert_eq!(segs(row, true), vec![(0, 0, 0, S)]);
        }
        for i in 0..rows.len() - 1 {
            assert_eq!(segs(&rows[i], true), segs(&rows[i + 1], false));
        }
        // 剩余状态：单个弱预留槽（h3 的延续线），而非每行一条泳道。
        assert_eq!(g.lanes, vec![LaneSlot::Tentative("h3".to_string())]);

        // 分页续读：跨页后依然折叠在泳道 0。
        let page2 = g.compute_graph_rows(vec![node("a4", &["h4"])]);
        assert_eq!(page2[0].lane_index, 0);
        assert_eq!(page2[0].lane_count, 1);
        assert_eq!(segs(&page2[0], false), vec![(0, 0, 0, S)]);
    }

    /// 页尾压缩不得低于 pending_above 引用的最大泳道：分页结果与单次全量
    /// 计算逐行一致（lane / lane_count / 连线），下一页首行的 lane_count
    /// 覆盖其 connections_above 的全部泳道引用。
    #[test]
    fn page_end_pop_keeps_pending_above_references() {
        // m = merge(b, c)，b、c 均以 a 为父；按 3 + 1 分页。
        let mut single = GraphState::new();
        let full = single.compute_graph_rows(vec![
            node("m", &["b", "c"]),
            node("b", &["a"]),
            node("c", &["a"]),
            node("a", &[]),
        ]);

        let mut g = GraphState::new();
        let page1 = g.compute_graph_rows(vec![
            node("m", &["b", "c"]),
            node("b", &["a"]),
            node("c", &["a"]),
        ]);
        let page2 = g.compute_graph_rows(vec![node("a", &[])]);

        // 页 1 末行 c 汇入泳道 0，其自身泳道 1 已释放但仍被 pending_above
        // 引用 → 不得压缩。
        assert_eq!(segs(&page1[2], true), vec![(1, 0, 0, M), (0, 0, 0, S)]);

        let paged: Vec<&CommitGraphRow> = page1.iter().chain(page2.iter()).collect();
        assert_eq!(paged.len(), full.len());
        for (i, (paged, single_row)) in paged.iter().zip(full.iter()).enumerate() {
            assert_eq!(paged.commit.id, single_row.commit.id, "第 {i} 行提交应一致");
            assert_eq!(paged.lane_index, single_row.lane_index, "第 {i} 行 lane 应一致");
            assert_eq!(
                paged.lane_count, single_row.lane_count,
                "第 {i} 行 lane_count 应一致"
            );
            assert_eq!(segs(paged, true), segs(single_row, true), "第 {i} 行 below 应一致");
        }

        // 不变量：任何行的连线引用不得超过 lane_count。
        for row in paged.into_iter().chain(full.iter()) {
            let bound = row.lane_count;
            for conn in row.connections_above.iter().chain(row.connections_below.iter()) {
                assert!(conn.from_lane < bound, "from_lane {conn:?} 越界（lane_count={bound}）");
                assert!(conn.to_lane < bound, "to_lane {conn:?} 越界（lane_count={bound}）");
            }
        }
    }

    #[test]
    fn commit_arriving_with_duplicate_reservations() {
        let mut g = GraphState::new();
        // 直接构造同一提交被预留于多个槽位的异常状态（防御路径）。
        g.lanes = vec![
            LaneSlot::Reserved("a".to_string()),
            LaneSlot::Reserved("x".to_string()),
            LaneSlot::Reserved("a".to_string()),
        ];
        g.lane_colors = vec![Some(0), Some(1), Some(2)];

        let rows = g.compute_graph_rows(vec![node("a", &["r"])]);
        let row = &rows[0];
        // 首个预留槽位为正式泳道；重复槽位被一并释放。
        assert_eq!(row.lane_index, 0);
        assert_eq!(row.lane_count, 3);
        // 父 r 延续泳道 0；泳道 1（x）穿越；槽位 2 已清空。
        assert_eq!(segs(row, true), vec![(0, 0, 0, S), (1, 1, 1, S)]);
        // 首页首行上方为空。
        assert!(row.connections_above.is_empty());
    }

    #[test]
    fn page_boundary_continues_lane_and_color() {
        let mut g = GraphState::new();
        let page1 = g.compute_graph_rows(vec![node("c1", &["c2"])]);
        assert_eq!(page1.len(), 1);
        assert!(page1[0].connections_above.is_empty());
        assert_eq!(segs(&page1[0], true), vec![(0, 0, 0, S)]);

        // 页 1 最后一条提交的父（c2）= 页 2 首条提交：竖线跨页延续。
        let page2 = g.compute_graph_rows(vec![node("c2", &["c3"])]);
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].lane_index, 0);
        assert_eq!(page2[0].color_index, 0);
        assert!(!page2[0].connections_above.is_empty());
        assert_eq!(segs(&page2[0], false), vec![(0, 0, 0, S)]);
        assert_eq!(segs(&page2[0], true), vec![(0, 0, 0, S)]);
    }

    #[test]
    fn empty_page_keeps_pending_state() {
        let mut g = GraphState::new();
        g.compute_graph_rows(vec![node("c1", &["c2"])]);
        let empty = g.compute_graph_rows(Vec::new());
        assert!(empty.is_empty());
        // 空页不破坏跨页 gap 状态。
        let page2 = g.compute_graph_rows(vec![node("c2", &["c3"])]);
        assert_eq!(segs(&page2[0], false), vec![(0, 0, 0, S)]);
    }
}
