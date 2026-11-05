/**
 * 左侧栏（docs/06 §2）：当前分支 + 跟踪更改 / 未跟踪文件 + 提交输入。
 *
 * - “更改”默认展开，合并展示已暂存和未暂存的跟踪文件；未跟踪文件默认折叠；
 * - 变更列表按**目录树**分组（外层目录折叠为一行 + 递归文件数），
 *   点开才展开下一层，避免扁平长列表；
 * - 文件行单击进入对应 diff（staged / workdir）；
 * - 行内 +/− 暂存 / 取消暂存；目录批量操作仅处理当前分组可见文件；
 * - 暂存组下方为提交信息输入（Cmd+Enter 提交）。
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  BranchIcon,
  CheckIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
} from "../Icons";
import { useAppStore } from "../../store/app";
import type { ChangedFile, ChangeType, FileStatus } from "../../types";
import "./Sidebar.css";

/** 变更类型 → 状态字母（对齐 IntelliJ：U=未跟踪 M=修改 A=新增 D=删除 R=重命名）。 */
const CHANGE_LETTER: Record<ChangeType, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  binary: "B",
  untracked: "U",
};

/** 按平台展示提交快捷键；实际处理始终同时支持 Meta 与 Ctrl。 */
const COMMIT_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘ ↵" : "Ctrl ↵";

/** 变更类型 → 中文说明（状态徽标悬浮提示）。 */
const CHANGE_LABEL: Record<ChangeType, string> = {
  modified: "已修改",
  added: "新增（已暂存）",
  deleted: "已删除",
  renamed: "重命名",
  binary: "二进制文件",
  untracked: "未跟踪（新文件，尚未 git add）",
};

/** 拆出目录与文件名。 */
function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

/** 由工作区状态构造单文件 ChangedFile（统计信息由 diff 视图按需计算）。 */
function makeChangedFile(entry: FileStatus, side: "staged" | "unstaged"): ChangedFile {
  return {
    path: entry.path,
    oldPath: null,
    changeType: (side === "staged" ? entry.staged : entry.unstaged) ?? "modified",
    additions: 0,
    deletions: 0,
  };
}

/** 目录树节点：由扁平路径构建的 trie。 */
interface DirNode {
  /** 本段目录名（不含斜杠）。 */
  name: string;
  /** 相对仓库根的完整目录路径（无尾斜杠）。 */
  path: string;
  /** 子目录（按名称不区分大小写排序）。 */
  dirs: DirNode[];
  /** 本层直接文件（按名称不区分大小写排序）。 */
  files: FileStatus[];
  /** 递归文件总数（含子目录）。 */
  count: number;
}

/** 把一组文件状态构建为目录树；根节点的 path 为空串。 */
function buildTree(entries: FileStatus[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [], count: 0 };
  const ensureDir = (node: DirNode, seg: string): DirNode => {
    let child = node.dirs.find(d => d.name === seg);
    if (!child) {
      child = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, dirs: [], files: [], count: 0 };
      node.dirs.push(child);
    }
    return child;
  };
  for (const entry of entries) {
    const segs = entry.path.split("/");
    let node = root;
    for (const seg of segs.slice(0, -1)) node = ensureDir(node, seg);
    node.files.push(entry);
  }
  // 自底向上汇总递归文件数。
  const summarize = (node: DirNode): number => {
    node.count = node.files.length + node.dirs.reduce((acc, d) => acc + summarize(d), 0);
    return node.count;
  };
  summarize(root);
  // 单子链压缩（自底向上）：目录只有一个子目录且无文件时合并显示，
  // 如 a/src/main/java → 一行 "a/src/main/java/"（IntelliJ / VS Code 行为）。
  // 根节点不参与压缩。
  const compress = (node: DirNode) => {
    node.dirs.forEach(compress);
    while (node !== root && node.files.length === 0 && node.dirs.length === 1) {
      const [child] = node.dirs;
      node.name = `${node.name}/${child.name}`;
      node.path = child.path;
      node.dirs = child.dirs;
      node.files = child.files;
    }
  };
  root.dirs.forEach(compress);
  // 目录与文件分别按名称不区分大小写排序。
  const sortNode = (node: DirNode) => {
    node.dirs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    node.files.sort((a, b) =>
      a.path.split("/").pop()!.toLowerCase().localeCompare(b.path.split("/").pop()!.toLowerCase()),
    );
    node.dirs.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

/** 当前过滤树中的文件集合；目录批量操作不得扩大到未显示的其它 Git 状态。 */
function collectFilePaths(node: DirNode): string[] {
  const paths = node.files.map(file => file.path);
  for (const dir of node.dirs) paths.push(...collectFilePaths(dir));
  return paths;
}

/** 可折叠文件分组。 */
function FileGroup({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="sidebar-group">
      <button type="button" className="sidebar-group-header" aria-expanded={open} onClick={onToggle}>
        <ChevronRightIcon className={`sidebar-caret${open ? " is-open" : ""}`} />
        <span className="sidebar-group-title">{title}</span>
        <span className="sidebar-group-count">{count}</span>
      </button>
      {open && <div className="sidebar-group-list">{children}</div>}
    </section>
  );
}

/** 单条文件状态行；showDir=false 时只显示文件名（目录树场景，路径由层级表达）。 */
function FileRow({
  entry,
  side,
  depth,
  showDir = true,
  onOpen,
  onToggleStage,
}: {
  entry: FileStatus;
  side: "staged" | "unstaged";
  depth: number;
  showDir?: boolean;
  onOpen: () => void;
  onToggleStage: () => void;
}) {
  const changeType = (side === "staged" ? entry.staged : entry.unstaged) ?? "modified";
  const sideLabel = changeType === "untracked" ? "未跟踪" : side === "staged" ? "已暂存" : "未暂存";
  const { dir, base } = splitPath(entry.path);
  return (
    <div className={`sidebar-file sidebar-file--${changeType}`}>
      <button
        type="button"
        className="sidebar-file-open"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={`${entry.path}\n${CHANGE_LABEL[changeType]} · ${sideLabel}`}
        aria-label={`${entry.path}，${CHANGE_LABEL[changeType]}，${sideLabel}`}
        onClick={onOpen}
      >
        <span className={`sidebar-file-status badge-${changeType}`} title={CHANGE_LABEL[changeType]}>
          {CHANGE_LETTER[changeType]}
        </span>
        <span className="sidebar-file-path">
          {showDir && dir && <span className="sidebar-file-dir">{dir}</span>}
          <span className="sidebar-file-base">{base}</span>
        </span>
      </button>
      <button
        type="button"
        className="icon-btn sidebar-stage-btn"
        aria-label={side === "staged" ? `取消暂存 ${entry.path}` : `暂存 ${entry.path}`}
        title={side === "staged" ? "取消暂存" : "暂存"}
        onClick={onToggleStage}
      >
        {side === "staged" ? <MinusIcon /> : <PlusIcon />}
      </button>
    </div>
  );
}

/** 目录树渲染：目录行（折叠/展开 + 整组暂存按钮）与文件行递归。 */
function TreeView({
  node,
  depth,
  side,
  expanded,
  onToggleDir,
  onOpenFile,
  onStageDir,
  onStageFile,
}: {
  node: DirNode;
  depth: number;
  side: "staged" | "unstaged";
  expanded: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (entry: FileStatus) => void;
  onStageDir: (path: string, visiblePaths: string[]) => void;
  onStageFile: (path: string) => void;
}) {
  const pad = { paddingLeft: `${8 + depth * 14}px` };
  return (
    <>
      {node.dirs.map(d => (
        <div key={`d:${d.path}`}>
          <div className="sidebar-dir" title={`${d.path}/（${d.count} 个文件）`}>
            <button
              type="button"
              className="sidebar-dir-toggle"
              style={pad}
              aria-expanded={expanded.has(d.path)}
              aria-label={`${expanded.has(d.path) ? "折叠" : "展开"} ${d.name}`}
              onClick={() => onToggleDir(d.path)}
            >
              <ChevronRightIcon className={`sidebar-caret${expanded.has(d.path) ? " is-open" : ""}`} />
              <span className="sidebar-dir-name">{d.name}/</span>
              <span className="sidebar-dir-count">{d.count}</span>
            </button>
            <button
              type="button"
              className="icon-btn sidebar-stage-btn"
              aria-label={side === "staged" ? `取消暂存目录 ${d.path}` : `暂存目录 ${d.path}`}
              title={side === "staged" ? `取消暂存整个目录（${d.count} 个文件）` : `暂存当前分组中的 ${d.count} 个文件`}
              onClick={() => onStageDir(d.path, collectFilePaths(d))}
            >
              {side === "staged" ? <MinusIcon /> : <PlusIcon />}
            </button>
          </div>
          {expanded.has(d.path) && (
            <TreeView
              node={d}
              depth={depth + 1}
              side={side}
              expanded={expanded}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onStageDir={onStageDir}
              onStageFile={onStageFile}
            />
          )}
        </div>
      ))}
      {node.files.map(f => (
        <FileRow
          key={`f:${f.path}`}
          entry={f}
          side={side}
          depth={depth}
          showDir={false}
          onOpen={() => onOpenFile(f)}
          onToggleStage={() => onStageFile(f.path)}
        />
      ))}
    </>
  );
}

export function Sidebar() {
  const repo = useAppStore(s => s.repo);
  const fileStatus = useAppStore(s => s.fileStatus);
  const loadFileStatus = useAppStore(s => s.loadFileStatus);
  const stageFile = useAppStore(s => s.stageFile);
  const stageFiles = useAppStore(s => s.stageFiles);
  const openFileDiff = useAppStore(s => s.openFileDiff);
  const createCommit = useAppStore(s => s.createCommit);

  const [changesOpen, setChangesOpen] = useState(true);
  const [untrackedOpen, setUntrackedOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  /** 展开的目录（按完整目录路径记录，各分组共享：切换分组不需要重新展开）。 */
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());

  const staged = fileStatus.filter(f => f.staged !== null);
  const untracked = fileStatus.filter(f => f.unstaged === "untracked");
  const trackedChanges = fileStatus.filter(f => f.staged !== null || (f.unstaged !== null && f.unstaged !== "untracked"));
  const changesTree = useMemo(() => buildTree(trackedChanges), [fileStatus]);
  const untrackedTree = useMemo(() => buildTree(untracked), [fileStatus]);

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openEntry = (entry: FileStatus, side: "staged" | "unstaged") => {
    const scope = side === "staged" ? { kind: "staged" as const } : { kind: "workdir" as const };
    void openFileDiff(scope, [makeChangedFile(entry, side)], 0);
  };

  const submitCommit = async () => {
    const msg = message.trim();
    if (!msg || staged.length === 0 || busy) return;
    setBusy(true);
    try {
      await createCommit(msg);
      // createCommit 内部捕获错误并以 error 状态表达失败；仅成功时清空输入。
      if (useAppStore.getState().error === null) setMessage("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="sidebar" aria-label="仓库侧栏">
      <div className="sidebar-section sidebar-workspace">
        <div className="sidebar-repo">
          <div className="sidebar-repo-copy">
            <span className="sidebar-repo-kicker">工作区</span>
            <span className="sidebar-repo-name" title={repo?.path}>
              {repo?.name}
            </span>
          </div>
        </div>
        <div className="sidebar-branch" title={repo?.headBranch ?? "分离 HEAD"}>
          <BranchIcon className="sidebar-branch-icon" />
          <span className="sidebar-branch-name">{repo?.headBranch ?? "(detached)"}</span>
          <span className="sidebar-branch-label">HEAD</span>
        </div>
      </div>

      <div className="sidebar-section sidebar-changes">
        <div className="sidebar-heading">
          <span>文件变更</span>
          <span className="sidebar-heading-count">{fileStatus.length}</span>
          <button
            type="button"
            className="icon-btn sidebar-refresh"
            aria-label="刷新文件状态"
            title="刷新文件状态"
            onClick={() => void loadFileStatus()}
          >
            <RefreshIcon />
          </button>
        </div>

        <div className="sidebar-groups">
          <FileGroup title="更改" count={trackedChanges.length} open={changesOpen} onToggle={() => setChangesOpen(v => !v)}>
            {trackedChanges.length > 0 ? (
              <TreeView
                node={changesTree}
                depth={0}
                side="unstaged"
                expanded={expandedDirs}
                onToggleDir={toggleDir}
                onOpenFile={f => openEntry(f, f.unstaged !== null && f.unstaged !== "untracked" ? "unstaged" : "staged")}
                onStageDir={(_, paths) => void stageFiles(paths)}
                onStageFile={p => void stageFile(p)}
              />
            ) : (
              <p className="sidebar-group-empty">没有未提交的跟踪更改</p>
            )}
          </FileGroup>
          <FileGroup
            title="未跟踪文件"
            count={untracked.length}
            open={untrackedOpen}
            onToggle={() => setUntrackedOpen(v => !v)}
          >
            {untracked.length > 0 ? (
              <TreeView
                node={untrackedTree}
                depth={0}
                side="unstaged"
                expanded={expandedDirs}
                onToggleDir={toggleDir}
                onOpenFile={f => openEntry(f, "unstaged")}
                onStageDir={(_, paths) => void stageFiles(paths)}
                onStageFile={p => void stageFile(p)}
              />
            ) : (
              <p className="sidebar-group-empty">没有未跟踪文件</p>
            )}
          </FileGroup>
        </div>

        <div className="sidebar-commit">
          <textarea
            className="sidebar-commit-input"
            placeholder="描述这次更改…"
            aria-label="提交信息"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submitCommit();
              }
            }}
          />
          <div className="sidebar-commit-actions">
            <span className="sidebar-commit-meta">
              {staged.length} 个文件
              <kbd title="Cmd/Ctrl + Enter">{COMMIT_SHORTCUT}</kbd>
            </span>
            <button
              type="button"
              className="btn btn-primary sidebar-commit-btn"
              disabled={busy || !message.trim() || staged.length === 0}
              onClick={() => void submitCommit()}
            >
              <CheckIcon />
              {busy ? "提交中…" : "提交"}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
