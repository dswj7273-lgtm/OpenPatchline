/**
 * Rust 侧线格式类型的 TypeScript 镜像（src-tauri/src/types.rs）。
 *
 * - 仅导出类型，无运行时代码；
 * - 字段 camelCase；枚举单元变体序列化为 camelCase 字符串
 *   （如 `"modified"`、`"branchOut"`、`"commit"`），与 Rust 侧
 *   `#[serde(rename_all = "camelCase")]` 一一对应。
 */

/** 已打开仓库的基本信息。 */
export interface RepoInfo {
  /** 仓库唯一标识：workdir 根路径 canonicalize 后的绝对路径。 */
  id: string;
  path: string;
  /** 仓库目录名。 */
  name: string;
  /** HEAD 分支名；分离 HEAD 时为 null。 */
  headBranch: string | null;
  /** HEAD 提交 id；空仓库时为空字符串。 */
  headCommit: string;
}

/** 目录扫描发现的子仓库（openRepository 返回 notARepo 时的候选项）。 */
export interface ChildRepo {
  /** 仓库目录名（展示用）。 */
  name: string;
  /** 仓库根目录绝对路径。 */
  path: string;
}

/** pick_and_open_repository 的返回结果。 */
export type OpenRepositoryOutcome =
  | { kind: "opened"; repo: RepoInfo }
  | { kind: "cancelled" }
  | { kind: "notARepo"; path: string; candidates: ChildRepo[] };

/** 提交历史过滤条件（get_commit_graph 参数）。 */
export interface LogFilter {
  branch: string | null;
  author: string | null;
  query: string | null;
  /** 起始时间，Unix 时间戳（秒）。 */
  since: number | null;
  /** 截止时间，Unix 时间戳（秒）。 */
  until: number | null;
}

/** 引用类别。 */
export type RefKind = "head" | "local" | "remote" | "tag";

/** 指向某提交的引用标签。 */
export interface RefLabel {
  name: string;
  kind: RefKind;
}

/** 提交图节点。 */
export interface CommitNode {
  id: string;
  /** 7 位短 hash。 */
  shortId: string;
  /** message 首行。 */
  message: string;
  authorName: string;
  authorEmail: string;
  /** Unix 时间戳（秒）。 */
  timestamp: number;
  parentIds: string[];
  refs: RefLabel[];
  /** 泳道列索引（graph 模块填充）。 */
  lane: number;
  /** 泳道颜色索引（graph 模块填充）。 */
  laneColor: number;
}

/** 连线形态。 */
export type ConnectionKind = "straight" | "branchOut" | "mergeIn";

/** 图中一段连线。 */
export interface Connection {
  fromLane: number;
  toLane: number;
  /** 颜色索引（0..8，对应 --graph-lane-N）。 */
  colorIndex: number;
  kind: ConnectionKind;
}

/** 提交图单行渲染所需的全部信息。 */
export interface CommitGraphRow {
  commit: CommitNode;
  laneIndex: number;
  /** 当前行活跃泳道总数。 */
  laneCount: number;
  /** 该提交节点的颜色索引。 */
  colorIndex: number;
  connectionsAbove: Connection[];
  connectionsBelow: Connection[];
}

/** 提交图分页结果。 */
export interface GraphPage {
  rows: CommitGraphRow[];
  /** 下一页游标（上一页最后一条 commit id）；无更多时为 null。 */
  nextCursor: string | null;
  hasMore: boolean;
}

/** 文件变更类别。 */
export type ChangeType =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "binary"
  | "untracked";

/** 单个文件的变更摘要。 */
export interface ChangedFile {
  path: string;
  /** 重命名前的原路径；非重命名时为 null。 */
  oldPath: string | null;
  changeType: ChangeType;
  additions: number;
  deletions: number;
}

/** Diff 行类别（spacer 由 RowCell 为 null 表示，无独立变体）。 */
export type LineKind = "context" | "added" | "removed";

/** 字符级差异区间：行内容内的字符偏移（含 start，不含 end）。 */
export interface CharRange {
  start: number;
  end: number;
}

/** 左右分栏中的单个单元格。 */
export interface RowCell {
  /** 行号；spacer 侧为 null。 */
  lineno: number | null;
  /** 行内容（不含换行符）。 */
  content: string;
  kind: LineKind;
  /** 字符级高亮区间（仅"相似"修改对填充，其余为空数组）。 */
  charRanges: CharRange[];
}

/**
 * 左右对齐后的一行：
 * - 两侧均非 null 且 kind 为 context：上下文行；
 * - 两侧均非 null 且为 removed/added：修改对行；
 * - 某一侧 null：占位（spacer）行。
 */
export interface AlignedRow {
  left: RowCell | null;
  right: RowCell | null;
}

/** 单文件 diff 的完整结果。 */
export interface FileDiffResult {
  oldPath: string | null;
  newPath: string | null;
  changeType: ChangeType;
  /** 二进制文件（rows 为空）。 */
  isBinary: boolean;
  /** 超过阈值被截断。 */
  tooLarge: boolean;
  rows: AlignedRow[];
  /** 变更行下标（导航用，升序）。 */
  changeRowIndices: number[];
  additions: number;
  deletions: number;
}

/** 工作区单个文件的状态（staged / unstaged 两栏）。 */
export interface FileStatus {
  path: string;
  staged: ChangeType | null;
  unstaged: ChangeType | null;
}

/** diff 范围类别。 */
export type DiffScopeKind = "commit" | "staged" | "workdir";

/** diff 查询范围（get_file_diff 参数）。 */
export type DiffScope =
  | { kind: "commit"; commitId: string }
  | { kind: "staged" }
  | { kind: "workdir" };

/** AppError 序列化后的载荷（invoke reject 时收到）。 */
export interface AppErrorPayload {
  /** 蛇形错误码："git" | "io" | "not_found" | "invalid_arg" | "too_large" | "unexpected"。 */
  code: string;
  message: string;
}
