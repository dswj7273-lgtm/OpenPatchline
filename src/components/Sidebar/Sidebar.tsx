/**
 * 左侧栏（docs/06 §2）：分支切换 + 已暂存 / 工作区更改 / 未跟踪文件 + 提交输入。
 *
 * - 支持右侧拖拽调整宽度（220px–420px）；
 * - 变更列表按目录树分组（单子链路径压缩 + 递归文件数），支持逐文件/逐目录/整组暂存与取消暂存；
 * - 文件行单击进入对应 diff（staged / workdir），当前正在审查的文件高亮提示；
 * - 底部提交卡片支持 Cmd/Ctrl + Enter 快捷提交。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  BranchIcon,
  CheckIcon,
  ChevronRightIcon,
  CommitIcon,
  MergeIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
} from "../Icons";
import { useAppStore } from "../../store/app";
import type { BranchInfo, ChangedFile, ChangeType, FileStatus } from "../../types";
import "./Sidebar.css";

const SIDEBAR_MIN_W = 220;
const SIDEBAR_MAX_W = 420;
const SIDEBAR_DEFAULT_W = 276;

function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem("openpatchline:sidebar-width");
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, parsed));
    }
  } catch {
    /* 忽略 */
  }
  return SIDEBAR_DEFAULT_W;
}

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
  added: "新增",
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
  name: string;
  path: string;
  dirs: DirNode[];
  files: FileStatus[];
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
  const summarize = (node: DirNode): number => {
    node.count = node.files.length + node.dirs.reduce((acc, d) => acc + summarize(d), 0);
    return node.count;
  };
  summarize(root);
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

/** 当前过滤树中的文件集合。 */
function collectFilePaths(node: DirNode): string[] {
  const paths = node.files.map(file => file.path);
  for (const dir of node.dirs) paths.push(...collectFilePaths(dir));
  return paths;
}

/** 可折叠文件分组（支持组级全部暂存 / 取消暂存）。 */
function FileGroup({
  title,
  count,
  accentCount,
  open,
  onToggle,
  batchLabel,
  batchIcon,
  onBatchAction,
  children,
}: {
  title: string;
  count: number;
  accentCount?: boolean;
  open: boolean;
  onToggle: () => void;
  batchLabel?: string;
  batchIcon?: ReactNode;
  onBatchAction?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="sidebar-group">
      <div className="sidebar-group-bar">
        <button type="button" className="sidebar-group-header" aria-expanded={open} onClick={onToggle}>
          <ChevronRightIcon className={`sidebar-caret${open ? " is-open" : ""}`} />
          <span className="sidebar-group-title">{title}</span>
          <span className={`sidebar-group-count${accentCount && count > 0 ? " is-accent" : ""}`}>{count}</span>
        </button>
        {count > 0 && onBatchAction && batchLabel && (
          <button
            type="button"
            className="icon-btn sidebar-group-batch"
            aria-label={batchLabel}
            title={batchLabel}
            onClick={e => {
              e.stopPropagation();
              onBatchAction();
            }}
          >
            {batchIcon}
          </button>
        )}
      </div>
      {open && <div className="sidebar-group-list">{children}</div>}
    </section>
  );
}

/** 单条文件状态行。 */
function FileRow({
  entry,
  side,
  depth,
  showDir = true,
  active = false,
  discardDisabled = false,
  onOpen,
  onToggleStage,
  onDiscard,
}: {
  entry: FileStatus;
  side: "staged" | "unstaged";
  depth: number;
  showDir?: boolean;
  active?: boolean;
  discardDisabled?: boolean;
  onOpen: () => void;
  onToggleStage: () => void;
  onDiscard?: () => void;
}) {
  const changeType = (side === "staged" ? entry.staged : entry.unstaged) ?? "modified";
  const sideLabel = changeType === "untracked" ? "未跟踪" : side === "staged" ? "已暂存" : "未暂存";
  const { dir, base } = splitPath(entry.path);
  return (
    <div className={`sidebar-file sidebar-file--${changeType}${active ? " is-active" : ""}`}>
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
      {side === "unstaged" && onDiscard && (
        <button
          type="button"
          className="icon-btn sidebar-stage-btn sidebar-discard-btn"
          disabled={discardDisabled}
          aria-label={`丢弃更改 ${entry.path}`}
          title={changeType === "untracked" ? "删除未跟踪文件" : "丢弃此文件工作区更改"}
          onClick={onDiscard}
        >
          <TrashIcon />
        </button>
      )}
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
  activePath,
  discardDisabled = false,
  onToggleDir,
  onOpenFile,
  onStageDir,
  onStageFile,
  onDiscardFile,
}: {
  node: DirNode;
  depth: number;
  side: "staged" | "unstaged";
  expanded: ReadonlySet<string>;
  activePath: string | null;
  discardDisabled?: boolean;
  onToggleDir: (path: string) => void;
  onOpenFile: (entry: FileStatus) => void;
  onStageDir: (path: string, visiblePaths: string[]) => void;
  onStageFile: (path: string) => void;
  onDiscardFile?: (path: string) => void;
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
              title={side === "staged" ? `取消暂存当前分组中的 ${d.count} 个文件` : `暂存当前分组中的 ${d.count} 个文件`}
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
              activePath={activePath}
              discardDisabled={discardDisabled}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onStageDir={onStageDir}
              onStageFile={onStageFile}
              onDiscardFile={onDiscardFile}
            />
          )}
        </div>
      ))}
      {node.files.map(f => (
        <FileRow
          key={`f:${side}:${f.path}`}
          entry={f}
          side={side}
          depth={depth}
          showDir={false}
          active={activePath === f.path}
          discardDisabled={discardDisabled}
          onOpen={() => onOpenFile(f)}
          onToggleStage={() => onStageFile(f.path)}
          onDiscard={onDiscardFile ? () => onDiscardFile(f.path) : undefined}
        />
      ))}
    </>
  );
}

/** 分支行 ahead/behind 徽标（如 `↑2 ↓1`）；无上游时不渲染。 */
function AheadBehind({ branch }: { branch: BranchInfo }) {
  if (branch.ahead === null && branch.behind === null) return null;
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  if (ahead === 0 && behind === 0) return null;
  return (
    <span className="sidebar-branch-sync" title={`领先上游 ${ahead}，落后 ${behind}`}>
      {ahead > 0 && <span className="sidebar-branch-ahead">↑{ahead}</span>}
      {behind > 0 && <span className="sidebar-branch-behind">↓{behind}</span>}
    </span>
  );
}

/** 分支面板：当前分支卡片 + 本地分支组 + 远程分支组。 */
function BranchPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const repo = useAppStore(s => s.repo);
  const branches = useAppStore(s => s.branches);
  const branchesLoading = useAppStore(s => s.branchesLoading);
  const gitBusy = useAppStore(s => s.gitBusy);
  const checkoutBranch = useAppStore(s => s.checkoutBranch);
  const createBranch = useAppStore(s => s.createBranch);
  const mergeBranch = useAppStore(s => s.mergeBranch);
  const deleteBranch = useAppStore(s => s.deleteBranch);
  const loadBranches = useAppStore(s => s.loadBranches);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");

  const currentBranch = useMemo(
    () => branches.find(b => b.isCurrent) ?? null,
    [branches],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const locals = useMemo(
    () =>
      branches.filter(
        b => b.kind === "local" && (!normalizedQuery || b.name.toLowerCase().includes(normalizedQuery)),
      ),
    [branches, normalizedQuery],
  );
  const remotes = useMemo(
    () =>
      branches.filter(
        b => b.kind === "remote" && (!normalizedQuery || b.name.toLowerCase().includes(normalizedQuery)),
      ),
    [branches, normalizedQuery],
  );

  const toggle = () => {
    const next = !open;
    onOpenChange(next);
    if (next) {
      setQuery("");
      void loadBranches();
    }
  };

  const pick = (name: string) => {
    if (gitBusy !== null) return;
    void checkoutBranch(name);
  };

  const submitNewBranch = async () => {
    const trimmed = newBranch.trim();
    if (!trimmed || gitBusy !== null) return;
    const ok = await createBranch(trimmed, null, true);
    if (ok) setNewBranch("");
  };

  return (
    <div className="sidebar-branch-block">
      <button
        type="button"
        className={`sidebar-branch${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-label={`当前分支 ${repo?.headBranch ?? "分离 HEAD"}，点击${open ? "收起" : "展开"}分支列表`}
        title={repo?.headBranch ? `当前分支：${repo.headBranch}` : "分离 HEAD"}
        onClick={toggle}
      >
        <BranchIcon className="sidebar-branch-icon" />
        <span className="sidebar-branch-name">{repo?.headBranch ?? "(detached)"}</span>
        {currentBranch && <AheadBehind branch={currentBranch} />}
        <span className="sidebar-branch-label">HEAD</span>
        <ChevronRightIcon className={`sidebar-caret sidebar-branch-caret${open ? " is-open" : ""}`} />
      </button>

      {open && (
        <div className="sidebar-branch-panel" role="listbox" aria-label="分支列表">
          <div className="sidebar-branch-create">
            <input
              type="text"
              className="sidebar-branch-create-input"
              placeholder="+ 新建分支并切换…"
              aria-label="新建分支名"
              value={newBranch}
              disabled={gitBusy !== null}
              onChange={e => setNewBranch(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitNewBranch();
                }
              }}
            />
            <button
              type="button"
              className="icon-btn sidebar-branch-create-btn"
              aria-label="创建并切换分支"
              title="创建并切换分支"
              disabled={gitBusy !== null || !newBranch.trim()}
              onClick={() => void submitNewBranch()}
            >
              <PlusIcon />
            </button>
          </div>

          {branches.length > 6 && (
            <div className="sidebar-branch-search">
              <SearchIcon />
              <input
                type="text"
                className="sidebar-branch-search-input"
                placeholder="筛选分支…"
                aria-label="筛选分支"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
          )}

          {branchesLoading && branches.length === 0 && (
            <p className="sidebar-branch-empty">加载分支中…</p>
          )}
          {!branchesLoading && branches.length === 0 && (
            <p className="sidebar-branch-empty">没有分支（空仓库）</p>
          )}
          {branches.length > 0 && locals.length === 0 && remotes.length === 0 && (
            <p className="sidebar-branch-empty">没有匹配的分支</p>
          )}

          {locals.length > 0 && <div className="sidebar-branch-group-title">本地分支</div>}
          {locals.map(b => (
            <div
              key={b.name}
              className={`sidebar-branch-row${b.isCurrent ? " is-current" : ""}`}
            >
              <button
                type="button"
                role="option"
                aria-selected={b.isCurrent}
                className={`sidebar-branch-item${b.isCurrent ? " is-current" : ""}`}
                disabled={gitBusy !== null || b.isCurrent}
                title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}
                onClick={() => pick(b.name)}
              >
                <span className="sidebar-branch-item-name">{b.name}</span>
                <AheadBehind branch={b} />
                {b.isCurrent && (
                  <span className="sidebar-branch-current">
                    <CheckIcon />
                  </span>
                )}
              </button>
              {!b.isCurrent && (
                <div className="sidebar-branch-ops">
                  <button
                    type="button"
                    className="icon-btn sidebar-branch-op"
                    disabled={gitBusy !== null}
                    aria-label={`合并分支 ${b.name} 到当前分支`}
                    title={`将 ${b.name} 合并到当前分支`}
                    onClick={() => void mergeBranch(b.name)}
                  >
                    <MergeIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-btn sidebar-branch-op is-danger"
                    disabled={gitBusy !== null}
                    aria-label={`删除分支 ${b.name}`}
                    title={`删除本地分支 ${b.name}`}
                    onClick={() => void deleteBranch(b.name, false)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </div>
          ))}

          {remotes.length > 0 && (
            <button
              type="button"
              className="sidebar-branch-group-toggle"
              aria-expanded={remoteOpen || Boolean(normalizedQuery)}
              onClick={() => setRemoteOpen(v => !v)}
            >
              <ChevronRightIcon
                className={`sidebar-caret${remoteOpen || normalizedQuery ? " is-open" : ""}`}
              />
              <span>远程分支</span>
              <span className="sidebar-group-count">{remotes.length}</span>
            </button>
          )}
          {(remoteOpen || Boolean(normalizedQuery)) &&
            remotes.map(b => (
              <button
                key={b.name}
                type="button"
                role="option"
                aria-selected={false}
                className="sidebar-branch-item sidebar-branch-item--remote"
                disabled={gitBusy !== null}
                title={`${b.name}（切换到该分支；无同名本地分支时创建跟踪分支）`}
                onClick={() => pick(b.name)}
              >
                <span className="sidebar-branch-item-name">{b.name}</span>
              </button>
            ))}

          {gitBusy === "checkout" && <p className="sidebar-branch-empty">切换分支中…</p>}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const repo = useAppStore(s => s.repo);
  const fileStatus = useAppStore(s => s.fileStatus);
  const loadFileStatus = useAppStore(s => s.loadFileStatus);
  const stageFile = useAppStore(s => s.stageFile);
  const stageFiles = useAppStore(s => s.stageFiles);
  const unstageFile = useAppStore(s => s.unstageFile);
  const unstageFiles = useAppStore(s => s.unstageFiles);
  const openFileDiff = useAppStore(s => s.openFileDiff);
  const createCommit = useAppStore(s => s.createCommit);
  const amendCommit = useAppStore(s => s.amendCommit);
  const discardFile = useAppStore(s => s.discardFile);
  const gitBusy = useAppStore(s => s.gitBusy);
  const graphRows = useAppStore(s => s.graphRows);
  const activeView = useAppStore(s => s.activeView);
  const diffScope = useAppStore(s => s.diffScope);
  const diffFiles = useAppStore(s => s.diffFiles);
  const selectedDiffFileIndex = useAppStore(s => s.selectedDiffFileIndex);

  const [width, setWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);

  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [untrackedOpen, setUntrackedOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [branchPanelOpen, setBranchPanelOpen] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    try {
      window.localStorage.setItem("openpatchline:sidebar-width", String(width));
    } catch {
      /* 忽略 */
    }
  }, [width]);

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, w: width };
    setResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const next = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, start.w + (e.clientX - start.x)));
    setWidth(next);
  };

  const onResizeEnd = () => {
    dragStartRef.current = null;
    setResizing(false);
  };

  const staged = useMemo(() => fileStatus.filter(f => f.staged !== null), [fileStatus]);
  const unstagedTracked = useMemo(
    () => fileStatus.filter(f => f.unstaged !== null && f.unstaged !== "untracked"),
    [fileStatus],
  );
  const untracked = useMemo(() => fileStatus.filter(f => f.unstaged === "untracked"), [fileStatus]);

  const stagedTree = useMemo(() => buildTree(staged), [staged]);
  const changesTree = useMemo(() => buildTree(unstagedTracked), [unstagedTracked]);
  const untrackedTree = useMemo(() => buildTree(untracked), [untracked]);

  const activeDiffPath = activeView === "diff" ? (diffFiles[selectedDiffFileIndex]?.path ?? null) : null;
  const activeStagedPath = diffScope?.kind === "staged" ? activeDiffPath : null;
  const activeWorkdirPath = diffScope?.kind === "workdir" ? activeDiffPath : null;

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

  const canSubmit =
    !busy &&
    gitBusy === null &&
    Boolean(message.trim()) &&
    (amend ? Boolean(repo?.headCommit) : staged.length > 0);

  const toggleAmend = (checked: boolean) => {
    setAmend(checked);
    if (checked && !message.trim()) {
      const headMsg =
        graphRows.find(r => r.commit.id === repo?.headCommit)?.commit.message ??
        graphRows[0]?.commit.message ??
        "";
      if (headMsg) setMessage(headMsg);
    }
  };

  const submitCommit = async () => {
    const msg = message.trim();
    if (!msg || !canSubmit) return;
    setBusy(true);
    try {
      if (amend) {
        const ok = await amendCommit(msg);
        if (ok) {
          setMessage("");
          setAmend(false);
        }
      } else {
        await createCommit(msg);
        if (useAppStore.getState().error === null) setMessage("");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className={`sidebar${resizing ? " is-resizing" : ""}`}
      style={{ width }}
      aria-label="仓库侧栏"
    >
      <div className="sidebar-section sidebar-workspace">
        <div className="sidebar-repo">
          <div className="sidebar-repo-copy">
            <span className="sidebar-repo-kicker">工作区</span>
            <span className="sidebar-repo-name" title={repo?.path}>
              {repo?.name}
            </span>
          </div>
        </div>
        <BranchPanel open={branchPanelOpen} onOpenChange={setBranchPanelOpen} />
      </div>

      <div className="sidebar-section sidebar-changes">
        <div className="sidebar-heading">
          <span>变更状态</span>
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
          <FileGroup
            title="已暂存"
            count={staged.length}
            accentCount
            open={stagedOpen}
            onToggle={() => setStagedOpen(v => !v)}
            batchLabel="取消暂存全部已暂存文件"
            batchIcon={<MinusIcon />}
            onBatchAction={() => void unstageFiles(staged.map(f => f.path))}
          >
            {staged.length > 0 ? (
              <TreeView
                node={stagedTree}
                depth={0}
                side="staged"
                expanded={expandedDirs}
                activePath={activeStagedPath}
                onToggleDir={toggleDir}
                onOpenFile={f => openEntry(f, "staged")}
                onStageDir={(_, paths) => void unstageFiles(paths)}
                onStageFile={p => void unstageFile(p)}
              />
            ) : (
              <p className="sidebar-group-empty">暂无已暂存更改</p>
            )}
          </FileGroup>

          <FileGroup
            title="工作区更改"
            count={unstagedTracked.length}
            open={changesOpen}
            onToggle={() => setChangesOpen(v => !v)}
            batchLabel="暂存全部工作区更改"
            batchIcon={<PlusIcon />}
            onBatchAction={() => void stageFiles(unstagedTracked.map(f => f.path))}
          >
            {unstagedTracked.length > 0 ? (
              <TreeView
                node={changesTree}
                depth={0}
                side="unstaged"
                expanded={expandedDirs}
                activePath={activeWorkdirPath}
                discardDisabled={gitBusy !== null}
                onToggleDir={toggleDir}
                onOpenFile={f => openEntry(f, "unstaged")}
                onStageDir={(_, paths) => void stageFiles(paths)}
                onStageFile={p => void stageFile(p)}
                onDiscardFile={p => void discardFile(p)}
              />
            ) : (
              <p className="sidebar-group-empty">工作区无未暂存修改</p>
            )}
          </FileGroup>

          <FileGroup
            title="未跟踪文件"
            count={untracked.length}
            open={untrackedOpen}
            onToggle={() => setUntrackedOpen(v => !v)}
            batchLabel="暂存全部未跟踪文件"
            batchIcon={<PlusIcon />}
            onBatchAction={() => void stageFiles(untracked.map(f => f.path))}
          >
            {untracked.length > 0 ? (
              <TreeView
                node={untrackedTree}
                depth={0}
                side="unstaged"
                expanded={expandedDirs}
                activePath={activeWorkdirPath}
                discardDisabled={gitBusy !== null}
                onToggleDir={toggleDir}
                onOpenFile={f => openEntry(f, "unstaged")}
                onStageDir={(_, paths) => void stageFiles(paths)}
                onStageFile={p => void stageFile(p)}
                onDiscardFile={p => void discardFile(p)}
              />
            ) : (
              <p className="sidebar-group-empty">没有未跟踪文件</p>
            )}
          </FileGroup>
        </div>

        <div className="sidebar-commit">
          <div className="sidebar-commit-card">
            <textarea
              className="sidebar-commit-input"
              placeholder="输入提交说明…"
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
            <label className="sidebar-commit-amend">
              <input
                type="checkbox"
                checked={amend}
                disabled={busy || !repo?.headCommit}
                onChange={e => toggleAmend(e.target.checked)}
              />
              <span>修正上次提交 (Amend)</span>
            </label>
            <div className="sidebar-commit-actions">
              <span className="sidebar-commit-meta">
                <span className={`sidebar-commit-staged${staged.length > 0 ? " has-staged" : ""}`}>
                  {staged.length} 已暂存
                </span>
                <kbd title="Cmd/Ctrl + Enter">{COMMIT_SHORTCUT}</kbd>
              </span>
              <button
                type="button"
                className="btn btn-primary sidebar-commit-btn"
                disabled={!canSubmit}
                onClick={() => void submitCommit()}
              >
                <CommitIcon />
                {busy ? "提交中…" : amend ? "修正提交" : "提交"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_W)}
      />
    </aside>
  );
}
