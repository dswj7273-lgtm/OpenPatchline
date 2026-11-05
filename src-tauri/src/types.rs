//! 跨进程（Rust ↔ TypeScript）线格式类型定义。
//!
//! 约定：
//! - 所有类型 `#[derive(Debug, Clone, Serialize)]`，命令参数额外实现 `Deserialize`；
//! - 结构体字段与枚举变体均 `#[serde(rename_all = "camelCase")]`；
//! - 枚举单元变体序列化为普通字符串（`ChangeType::Modified` → `"modified"`，
//!   `ConnectionKind::BranchOut` → `"branchOut"`，`DiffScopeKind::Commit` → `"commit"`）。
//!
//! TypeScript 侧镜像类型见 `src/types/index.ts`，两边必须保持一致。

use serde::{Deserialize, Serialize};

/// 已打开仓库的基本信息（命令 `pick_and_open_repository` 的返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// 仓库唯一标识：workdir 根路径 canonicalize 后的绝对路径。
    pub id: String,
    /// 仓库工作目录路径。
    pub path: String,
    /// 仓库目录名（展示用）。
    pub name: String,
    /// HEAD 指向的分支名；分离 HEAD 时为 None。
    pub head_branch: Option<String>,
    /// HEAD 指向的提交 id；空仓库时为空字符串。
    pub head_commit: String,
}

/// `pick_and_open_repository` 的返回结果（tagged enum，`kind` 字段区分）。
///
/// - `opened`：成功打开；
/// - `cancelled`：用户在目录选择框中取消；
/// - `notARepo`：所选目录不是 Git 仓库；`candidates` 为其直接子目录中
///   扫描到的仓库（工作区目录场景），前端据此弹出选择列表。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenRepositoryOutcome {
    Opened {
        repo: RepoInfo,
    },
    Cancelled,
    NotARepo {
        /// 所选目录（canonicalize 后）。
        path: String,
        /// 直接子目录中的 Git 仓库（按名称排序），可为空。
        candidates: Vec<ChildRepo>,
    },
}

/// 目录扫描发现的子仓库（`OpenRepositoryOutcome::NotARepo` 的候选项）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildRepo {
    /// 仓库目录名（展示用）。
    pub name: String,
    /// 仓库根目录绝对路径。
    pub path: String,
}

/// 提交历史过滤条件（命令参数）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    /// 遍历起点引用（分支名 / 引用名）；None 表示默认 HEAD。
    pub branch: Option<String>,
    /// 按作者名或邮箱做子串匹配。
    pub author: Option<String>,
    /// 按 commit message 做子串匹配。
    pub query: Option<String>,
    /// 起始时间（Unix 时间戳，秒，含）。
    pub since: Option<i64>,
    /// 截止时间（Unix 时间戳，秒，含）。
    pub until: Option<i64>,
}

/// 引用类别。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// HEAD 解析出的当前分支。
    Head,
    /// 本地分支。
    Local,
    /// 远程跟踪分支（refs/remotes/…）。
    Remote,
    /// 标签（refs/tags/…）。
    Tag,
}

/// 指向某提交的引用标签（在提交列表内联展示为徽章）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    /// 引用短名（如 `main`、`origin/main`、`v1.0.0`）。
    pub name: String,
    pub kind: RefKind,
}

/// 提交图节点。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitNode {
    /// 完整 commit hash。
    pub id: String,
    /// 7 位短 hash。
    pub short_id: String,
    /// commit message 首行（subject）。
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    /// 作者时间，Unix 时间戳（秒）。
    pub timestamp: i64,
    /// 父提交 id 列表（第一个为一线父提交）。
    pub parent_ids: Vec<String>,
    /// 指向此提交的引用标签（HEAD、分支、标签等）。
    pub refs: Vec<RefLabel>,
    /// 泳道列索引；由 git_service 产出时保持默认 0，graph 模块填充。
    pub lane: usize,
    /// 泳道颜色索引；由 git_service 产出时保持默认 0，graph 模块填充。
    pub lane_color: usize,
}

/// 一条连线的形态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionKind {
    /// 竖线：from_lane == to_lane。
    Straight,
    /// 向右分叉（新分支从此行开始）。
    BranchOut,
    /// 向左合并（分支在此行汇入）。
    MergeIn,
}

/// 图中一段连线（某行上方或下方的一小段线）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub from_lane: usize,
    pub to_lane: usize,
    /// 颜色索引（0..LANE_COLORS）。
    pub color_index: usize,
    pub kind: ConnectionKind,
}

/// 提交图单行渲染所需的全部信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphRow {
    /// 该行的提交节点（lane / lane_color 已被 graph 模块回填）。
    pub commit: CommitNode,
    /// 该提交所在泳道列索引。
    pub lane_index: usize,
    /// 当前行活跃泳道总数（决定图形列宽度）。
    pub lane_count: usize,
    /// 该提交节点的颜色索引（对应 CSS `--graph-lane-N`）。
    pub color_index: usize,
    /// 此行上方的连线段（与上一行之间）。
    pub connections_above: Vec<Connection>,
    /// 此行下方的连线段（与下一行之间）。
    pub connections_below: Vec<Connection>,
}

/// 提交图分页结果（cursor-based pagination）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    /// 本页图行，newest-first。
    pub rows: Vec<CommitGraphRow>,
    /// 下一页游标（上一页最后一条 commit id）；`has_more` 为 false 时为 None。
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

/// 文件变更类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeType {
    Modified,
    Added,
    Deleted,
    /// 重命名（可能伴随内容修改）。
    Renamed,
    /// 二进制文件（无法做文本 diff）。
    Binary,
    /// 未跟踪文件（仅出现在工作区状态中）。
    Untracked,
}

/// 单个文件的变更摘要（提交变更列表 / diff 文件列表共用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// （新）路径。
    pub path: String,
    /// 重命名前的原路径；非重命名时为 None。
    pub old_path: Option<String>,
    pub change_type: ChangeType,
    /// 新增行数（二进制文件为 0）。
    pub additions: u32,
    /// 删除行数（二进制文件为 0）。
    pub deletions: u32,
}

/// Diff 行类别。
///
/// 注意：没有 Spacer 变体——占位行在 [`crate::types::RowCell`] 层用
/// `Option::None` 表示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    /// 上下文行（未修改，两侧同现）。
    Context,
    /// 新增行（仅右侧）。
    Added,
    /// 删除行（仅左侧）。
    Removed,
}

/// 字符级差异区间：行内容内的字符偏移（UTF-8 安全，按字符计）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharRange {
    /// 起始字符偏移（含）。
    pub start: usize,
    /// 结束字符偏移（不含）。
    pub end: usize,
}

/// 左右分栏中的单个单元格。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCell {
    /// 行号；spacer / 无行号侧为 None。
    pub lineno: Option<u32>,
    /// 行内容（不含换行符；spacer 单元格无需构造）。
    pub content: String,
    pub kind: LineKind,
    /// 字符级高亮区间（仅"相似"的修改对填充，其余为空）。
    pub char_ranges: Vec<CharRange>,
}

/// 左右对齐后的一行。
///
/// - `left` / `right` 均 Some 且 kind 为 Context：上下文行；
/// - 均 Some 且为 Removed/Added：修改对行（字符级 diff 的作用对象）；
/// - 某一侧 None：占位（spacer）行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedRow {
    pub left: Option<RowCell>,
    pub right: Option<RowCell>,
}

/// 单文件 diff 的完整结果（命令 `get_file_diff` 的返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResult {
    /// 旧路径（重命名 / 删除时与 new_path 不同）。
    pub old_path: Option<String>,
    /// 新路径。
    pub new_path: Option<String>,
    pub change_type: ChangeType,
    /// 内容为二进制，无法做文本 diff（此时 rows 为空）。
    pub is_binary: bool,
    /// 超过大小/行数阈值被截断（docs/05 §8）。
    pub too_large: bool,
    /// 左右对齐的行列表。
    pub rows: Vec<AlignedRow>,
    /// 变更行下标（left 为 Removed 或 right 为 Added 的行），供跳转导航。
    pub change_row_indices: Vec<usize>,
    pub additions: u32,
    pub deletions: u32,
}

/// 工作区单个文件的状态（staged / unstaged 两栏）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// 暂存区 vs HEAD 的状态；未暂存任何变更时为 None。
    pub staged: Option<ChangeType>,
    /// 工作区 vs 暂存区的状态；含未跟踪文件（Some(Untracked)）。
    pub unstaged: Option<ChangeType>,
}

/// diff 范围类别（命令参数）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScopeKind {
    /// 某次提交 vs 其第一个父提交。
    Commit,
    /// 暂存区 vs HEAD。
    Staged,
    /// 工作区 vs 暂存区（或 HEAD）。
    Workdir,
}

/// diff 查询范围（命令 `get_file_diff` 的参数）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffScope {
    pub kind: DiffScopeKind,
    /// 目标提交 id；仅 `kind == Commit` 时为 Some。
    pub commit_id: Option<String>,
}
