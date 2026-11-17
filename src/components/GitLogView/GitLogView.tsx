/**
 * Git Log 视图（docs/06 §3）：单体式智能搜索栏（Omni-Search Bar）+ 轻量远程操作栏 + 提交表 + 提交详情。
 *
 * - 支持普通文本搜索提交信息 / 哈希（300ms 防抖）；
 * - 支持内联作者 / 分支筛选胶囊（Token Pill），Backspace 快速删除最后一个标签；
 * - 输入 `@` 触发作者候选面板、输入 `#` 触发分支候选面板，或点击右侧图标切换统一快选面板；
 * - 支持 ArrowUp / ArrowDown / Enter / Escape 键盘导航。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BranchIcon,
  CalendarIcon,
  CheckIcon,
  CherryPickIcon,
  ChevronDownIcon,
  CloseIcon,
  MergeIcon,
  PullIcon,
  PushIcon,
  RebaseIcon,
  RefreshIcon,
  SearchIcon,
  StashIcon,
  TagIcon,
  TerminalIcon,
  TrashIcon,
  UndoIcon,
  UserIcon,
} from "../Icons";
import { useAppStore } from "../../store/app";
import { CommitDetail } from "./CommitDetail";
import { CommitTable } from "./CommitTable";
import { RebaseModal } from "./RebaseModal";
import "./GitLogView.css";

/** 输入防抖（ms）。 */
const FILTER_DEBOUNCE_MS = 300;
const SEARCH_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘F" : "Ctrl F";

type PopoverTab = "author" | "branch" | "date";
type CommandTab = "sync" | "branch" | "stash" | "reset";

function formatLocalDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function unixToDateInput(ts: number | null): string {
  if (ts === null) return "";
  return formatLocalDateInput(new Date(ts * 1000));
}

function dateInputToUnix(value: string, boundary: "start" | "end"): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  const dt =
    boundary === "start"
      ? new Date(y, m - 1, d, 0, 0, 0, 0)
      : new Date(y, m - 1, d, 23, 59, 59, 999);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.floor(dt.getTime() / 1000);
}

function formatDatePill(sinceDate: string, untilDate: string): string {
  if (sinceDate && untilDate) {
    return sinceDate === untilDate ? sinceDate : `${sinceDate} ~ ${untilDate}`;
  }
  if (sinceDate) return `${sinceDate} 起`;
  return `截至 ${untilDate}`;
}

interface SuggestionItem {
  value: string;
  label: string;
  meta?: string;
}

/** 集成 Git 命令中心浮层（同步 / 分支与标签 / 贮藏 / 撤销与清理）。 */
function GitCommandCenter({
  activeTab,
  onTabChange,
  onOpenRebase,
  onClose,
}: {
  activeTab: CommandTab;
  onTabChange: (tab: CommandTab) => void;
  onOpenRebase: () => void;
  onClose: () => void;
}) {
  const repo = useAppStore((s) => s.repo);
  const branches = useAppStore((s) => s.branches);
  const stashes = useAppStore((s) => s.stashes);
  const fileStatus = useAppStore((s) => s.fileStatus);
  const gitBusy = useAppStore((s) => s.gitBusy);

  const fetchRemote = useAppStore((s) => s.fetchRemote);
  const fetchAll = useAppStore((s) => s.fetchAll);
  const pullRepo = useAppStore((s) => s.pullRepo);
  const pullRebase = useAppStore((s) => s.pullRebase);
  const pushRepo = useAppStore((s) => s.pushRepo);
  const pushForceWithLease = useAppStore((s) => s.pushForceWithLease);
  const pushTags = useAppStore((s) => s.pushTags);

  const createBranch = useAppStore((s) => s.createBranch);
  const createTag = useAppStore((s) => s.createTag);
  const mergeBranch = useAppStore((s) => s.mergeBranch);

  const stashPush = useAppStore((s) => s.stashPush);
  const stashApply = useAppStore((s) => s.stashApply);
  const stashDrop = useAppStore((s) => s.stashDrop);
  const loadStashes = useAppStore((s) => s.loadStashes);

  const resetHead = useAppStore((s) => s.resetHead);
  const discardAllChanges = useAppStore((s) => s.discardAllChanges);

  const [newBranchName, setNewBranchName] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [confirmForcePush, setConfirmForcePush] = useState(false);

  const mergeCandidates = useMemo(() => branches.filter((b) => !b.isCurrent), [branches]);
  const currentBranch = useMemo(() => branches.find((b) => b.isCurrent) ?? null, [branches]);
  const aheadCount = currentBranch?.ahead ?? 0;
  const behindCount = currentBranch?.behind ?? 0;

  useEffect(() => {
    if (mergeCandidates.length > 0 && !mergeCandidates.some((b) => b.name === mergeTarget)) {
      setMergeTarget(mergeCandidates[0].name);
    } else if (mergeCandidates.length === 0) {
      setMergeTarget("");
    }
  }, [mergeCandidates, mergeTarget]);

  useEffect(() => {
    if (activeTab === "stash") {
      void loadStashes();
    }
    setConfirmDiscardAll(false);
    setConfirmForcePush(false);
  }, [activeTab, loadStashes]);

  const busy = gitBusy !== null;

  const runAndClose = async (fn: () => Promise<void>) => {
    await fn();
    onClose();
  };

  const onCreateBranch = async () => {
    const trimmed = newBranchName.trim();
    if (!trimmed || busy) return;
    const ok = await createBranch(trimmed, null, true);
    if (ok) {
      setNewBranchName("");
      onClose();
    }
  };

  const onCreateTag = async () => {
    const trimmed = newTagName.trim();
    if (!trimmed || busy) return;
    const ok = await createTag(trimmed, null);
    if (ok) {
      setNewTagName("");
      onClose();
    }
  };

  const onStashPush = async () => {
    if (busy) return;
    const ok = await stashPush(stashMessage.trim() || null);
    if (ok) setStashMessage("");
  };

  const tabs: { id: CommandTab; label: string }[] = [
    { id: "sync", label: "同步" },
    { id: "branch", label: "分支/标签" },
    { id: "stash", label: stashes.length > 0 ? `贮藏 (${stashes.length})` : "贮藏" },
    { id: "reset", label: "撤销/清理" },
  ];

  return (
    <div className="gitlog-cmd-popover" role="dialog" aria-label="Git 命令中心">
      <div className="gitlog-cmd-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`gitlog-cmd-tab${activeTab === t.id ? " is-active" : ""}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="gitlog-cmd-body">
        {activeTab === "sync" && (
          <div className="gitlog-cmd-section">
            <div className="gitlog-cmd-grid">
              <button
                type="button"
                className="gitlog-cmd-item"
                disabled={busy}
                onClick={() => void runAndClose(fetchRemote)}
              >
                <RefreshIcon />
                <div className="gitlog-cmd-item-copy">
                  <span className="gitlog-cmd-item-title">获取默认远程</span>
                  <span className="gitlog-cmd-item-sub">git fetch --prune</span>
                </div>
              </button>
              <button
                type="button"
                className="gitlog-cmd-item"
                disabled={busy}
                onClick={() => void runAndClose(fetchAll)}
              >
                <RefreshIcon />
                <div className="gitlog-cmd-item-copy">
                  <span className="gitlog-cmd-item-title">获取全部远程</span>
                  <span className="gitlog-cmd-item-sub">git fetch --all --prune</span>
                </div>
              </button>
              <button
                type="button"
                className="gitlog-cmd-item"
                disabled={busy}
                onClick={() => void runAndClose(pullRepo)}
              >
                <PullIcon />
                <div className="gitlog-cmd-item-copy">
                  <span className="gitlog-cmd-item-title">
                    合并拉取
                    {behindCount > 0 && (
                      <span className="gitlog-seg-badge is-behind">↓{behindCount}</span>
                    )}
                  </span>
                  <span className="gitlog-cmd-item-sub">git pull --no-edit</span>
                </div>
              </button>
              <button
                type="button"
                className="gitlog-cmd-item"
                disabled={busy}
                onClick={() => void runAndClose(pullRebase)}
              >
                <CherryPickIcon />
                <div className="gitlog-cmd-item-copy">
                  <span className="gitlog-cmd-item-title">
                    变基拉取
                    {behindCount > 0 && (
                      <span className="gitlog-seg-badge is-behind">↓{behindCount}</span>
                    )}
                  </span>
                  <span className="gitlog-cmd-item-sub">git pull --rebase --autostash</span>
                </div>
              </button>
              <button
                type="button"
                className="gitlog-cmd-item"
                disabled={busy}
                onClick={() => void runAndClose(pushRepo)}
              >
                <PushIcon />
                <div className="gitlog-cmd-item-copy">
                  <span className="gitlog-cmd-item-title">
                    推送当前分支
                    {aheadCount > 0 && (
                      <span className="gitlog-seg-badge is-ahead">↑{aheadCount}</span>
                    )}
                  </span>
                  <span className="gitlog-cmd-item-sub">git push</span>
                </div>
              </button>
              <button
                type="button"
                className="gitlog-cmd-item gitlog-cmd-item--warn"
                disabled={busy}
                onClick={() => setConfirmForcePush(true)}
              >
                <PushIcon />
                <div className="gitlog-cmd-item-copy">
                  <span className="gitlog-cmd-item-title">安全强推</span>
                  <span className="gitlog-cmd-item-sub">git push --force-with-lease</span>
                </div>
              </button>
              <button
                type="button"
                className="gitlog-cmd-item"
                disabled={busy}
                onClick={() => void runAndClose(pushTags)}
              >
                <TagIcon />
                <div className="gitlog-cmd-item-copy">
                  <span className="gitlog-cmd-item-title">推送全部标签</span>
                  <span className="gitlog-cmd-item-sub">git push --tags</span>
                </div>
              </button>
            </div>
            {confirmForcePush && (
              <div className="gitlog-cmd-confirm">
                <span className="gitlog-cmd-confirm-text">
                  确认执行安全强推 (git push --force-with-lease)？这可能覆盖远端分支历史。
                </span>
                <div className="gitlog-cmd-confirm-ops">
                  <button
                    type="button"
                    className="btn gitlog-mini-btn"
                    onClick={() => setConfirmForcePush(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn gitlog-mini-btn is-danger-solid"
                    disabled={busy}
                    onClick={() => void runAndClose(pushForceWithLease)}
                  >
                    确认强推
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "branch" && (
          <div className="gitlog-cmd-section">
            <div className="gitlog-cmd-field">
              <label className="gitlog-cmd-label" htmlFor="cmd-new-branch">
                新建并切换分支（checkout -b）
              </label>
              <div className="gitlog-cmd-row">
                <input
                  id="cmd-new-branch"
                  type="text"
                  className="input gitlog-cmd-input"
                  placeholder="例如 feat/dark-graph"
                  value={newBranchName}
                  disabled={busy}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void onCreateBranch();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary gitlog-cmd-submit"
                  disabled={busy || !newBranchName.trim()}
                  onClick={() => void onCreateBranch()}
                >
                  创建
                </button>
              </div>
            </div>

            <div className="gitlog-cmd-field">
              <label className="gitlog-cmd-label" htmlFor="cmd-new-tag">
                在当前 HEAD 创建标签（git tag）
              </label>
              <div className="gitlog-cmd-row">
                <input
                  id="cmd-new-tag"
                  type="text"
                  className="input gitlog-cmd-input"
                  placeholder="例如 v0.2.0"
                  value={newTagName}
                  disabled={busy}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void onCreateTag();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn gitlog-cmd-submit"
                  disabled={busy || !newTagName.trim()}
                  onClick={() => void onCreateTag()}
                >
                  打标签
                </button>
              </div>
            </div>

            <div className="gitlog-cmd-field">
              <label className="gitlog-cmd-label" htmlFor="cmd-merge-branch">
                合并分支到 {repo?.headBranch ?? "当前 HEAD"}（git merge）
              </label>
              <div className="gitlog-cmd-row">
                <select
                  id="cmd-merge-branch"
                  className="input gitlog-cmd-input"
                  value={mergeTarget}
                  disabled={busy || mergeCandidates.length === 0}
                  onChange={(e) => setMergeTarget(e.target.value)}
                >
                  {mergeCandidates.length === 0 ? (
                    <option value="">暂无其他分支可合并</option>
                  ) : (
                    mergeCandidates.map((b) => (
                      <option key={`${b.kind}:${b.name}`} value={b.name}>
                        {b.kind === "remote" ? `[远程] ${b.name}` : b.name}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  className="btn gitlog-cmd-submit"
                  disabled={busy || !mergeTarget}
                  onClick={() => void runAndClose(() => mergeBranch(mergeTarget))}
                >
                  <MergeIcon />
                  合并
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "stash" && (
          <div className="gitlog-cmd-section">
            <div className="gitlog-cmd-field">
              <div className="gitlog-cmd-row">
                <input
                  type="text"
                  className="input gitlog-cmd-input"
                  placeholder="贮藏备注（可选，包含未跟踪文件）…"
                  aria-label="贮藏备注"
                  value={stashMessage}
                  disabled={busy}
                  onChange={(e) => setStashMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void onStashPush();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary gitlog-cmd-submit"
                  disabled={busy || fileStatus.length === 0}
                  title="git stash push -u"
                  onClick={() => void onStashPush()}
                >
                  贮藏
                </button>
                <button
                  type="button"
                  className="btn gitlog-cmd-submit"
                  disabled={busy || stashes.length === 0}
                  title="弹出最近一条贮藏（git stash pop）"
                  onClick={() => void stashApply(stashes[0].index, true)}
                >
                  弹出最新
                </button>
              </div>
            </div>

            <div className="gitlog-stash-list">
              {stashes.length === 0 ? (
                <div className="gitlog-cmd-empty">当前没有贮藏条目</div>
              ) : (
                stashes.map((entry) => (
                  <div key={entry.index} className="gitlog-stash-item">
                    <div className="gitlog-stash-copy">
                      <div className="gitlog-stash-top">
                        <span className="gitlog-stash-ref">stash@{`{${entry.index}}`}</span>
                        <span className="gitlog-stash-sha">{entry.id}</span>
                      </div>
                      <span className="gitlog-stash-msg" title={entry.message}>
                        {entry.message}
                      </span>
                    </div>
                    <div className="gitlog-stash-ops">
                      <button
                        type="button"
                        className="gitlog-mini-btn"
                        disabled={busy}
                        title="弹出（stash pop）"
                        onClick={() => void stashApply(entry.index, true)}
                      >
                        弹出
                      </button>
                      <button
                        type="button"
                        className="gitlog-mini-btn"
                        disabled={busy}
                        title="应用但保留（stash apply）"
                        onClick={() => void stashApply(entry.index, false)}
                      >
                        应用
                      </button>
                      <button
                        type="button"
                        className="gitlog-mini-btn is-danger"
                        disabled={busy}
                        title="删除（stash drop）"
                        onClick={() => void stashDrop(entry.index)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === "reset" && (
          <div className="gitlog-cmd-section">
            <button
              type="button"
              className="gitlog-cmd-item gitlog-cmd-item--full"
              disabled={busy}
              onClick={() => {
                onClose();
                onOpenRebase();
              }}
            >
              <RebaseIcon />
              <div className="gitlog-cmd-item-copy">
                <span className="gitlog-cmd-item-title">整理最近提交（Squash / Reword）</span>
                <span className="gitlog-cmd-item-sub">git rebase -i (lightweight)</span>
              </div>
            </button>
            <button
              type="button"
              className="gitlog-cmd-item gitlog-cmd-item--full"
              disabled={busy}
              onClick={() => void runAndClose(() => resetHead("HEAD~1", "soft"))}
            >
              <UndoIcon />
              <div className="gitlog-cmd-item-copy">
                <span className="gitlog-cmd-item-title">撤销上次提交（保留暂存）</span>
                <span className="gitlog-cmd-item-sub">git reset --soft HEAD~1</span>
              </div>
            </button>
            <button
              type="button"
              className="gitlog-cmd-item gitlog-cmd-item--full"
              disabled={busy}
              onClick={() => void runAndClose(() => resetHead("HEAD~1", "mixed"))}
            >
              <UndoIcon />
              <div className="gitlog-cmd-item-copy">
                <span className="gitlog-cmd-item-title">撤销上次提交（保留工作区修改）</span>
                <span className="gitlog-cmd-item-sub">git reset --mixed HEAD~1</span>
              </div>
            </button>

            <div className="gitlog-cmd-danger-box">
              {!confirmDiscardAll ? (
                <button
                  type="button"
                  className="gitlog-cmd-item gitlog-cmd-item--full gitlog-cmd-item--danger"
                  disabled={busy || fileStatus.length === 0}
                  onClick={() => setConfirmDiscardAll(true)}
                >
                  <TrashIcon />
                  <div className="gitlog-cmd-item-copy">
                    <span className="gitlog-cmd-item-title">
                      丢弃工作区全部未提交更改 ({fileStatus.length})
                    </span>
                    <span className="gitlog-cmd-item-sub">
                      git reset --hard HEAD &amp;&amp; git clean -fd
                    </span>
                  </div>
                </button>
              ) : (
                <div className="gitlog-cmd-confirm">
                  <span className="gitlog-cmd-confirm-text">
                    确认永久丢弃全部 {fileStatus.length} 项未提交更改及未跟踪文件？
                  </span>
                  <div className="gitlog-cmd-confirm-ops">
                    <button
                      type="button"
                      className="btn gitlog-mini-btn"
                      onClick={() => setConfirmDiscardAll(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn gitlog-mini-btn is-danger-solid"
                      disabled={busy}
                      onClick={() => void runAndClose(discardAllChanges)}
                    >
                      确认丢弃
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function GitLogView() {
  const logFilter = useAppStore((s) => s.logFilter);
  const setLogFilter = useAppStore((s) => s.setLogFilter);
  const selectedCommitId = useAppStore((s) => s.selectedCommitId);
  const compareRange = useAppStore((s) => s.compareRange);
  const graphLoading = useAppStore((s) => s.graphLoading);
  const graphRows = useAppStore((s) => s.graphRows);
  const branches = useAppStore((s) => s.branches);
  const stashes = useAppStore((s) => s.stashes);
  const gitBusy = useAppStore((s) => s.gitBusy);

  const [search, setSearch] = useState("");
  const [author, setAuthor] = useState("");
  const [branch, setBranch] = useState("");
  const [sinceDate, setSinceDate] = useState(() => unixToDateInput(logFilter.since));
  const [untilDate, setUntilDate] = useState(() => unixToDateInput(logFilter.until));
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverTab, setPopoverTab] = useState<PopoverTab>("branch");
  const [activeIndex, setActiveIndex] = useState(0);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdTab, setCmdTab] = useState<CommandTab>("sync");
  const [rebaseOpen, setRebaseOpen] = useState(false);

  const omnibarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 外部切换分支导致 logFilter.branch 被清空时，同步清除内联分支标签。
  const filterBranch = logFilter.branch ?? "";
  useEffect(() => {
    setBranch(filterBranch);
  }, [filterBranch]);

  const filterSince = logFilter.since;
  const filterUntil = logFilter.until;
  useEffect(() => {
    setSinceDate(unixToDateInput(filterSince));
    setUntilDate(unixToDateInput(filterUntil));
  }, [filterSince, filterUntil]);

  const isPrefixCommand = search.startsWith("@") || search.startsWith("#");
  const filterRef = useRef(logFilter);
  filterRef.current = logFilter;

  useEffect(() => {
    const timer = setTimeout(() => {
      const query = isPrefixCommand ? null : search.trim() || null;
      const authorName = author.trim() || null;
      const branchName = branch.trim() || null;
      let since = dateInputToUnix(sinceDate, "start");
      let until = dateInputToUnix(untilDate, "end");
      if (since !== null && until !== null && since > until) {
        [since, until] = [until, since];
      }
      const cur = filterRef.current;
      if (
        cur.query === query &&
        cur.author === authorName &&
        cur.branch === branchName &&
        cur.since === since &&
        cur.until === until
      ) {
        return;
      }
      setLogFilter({ ...cur, query, author: authorName, branch: branchName, since, until });
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, author, branch, sinceDate, untilDate, isPrefixCommand, setLogFilter]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!popoverOpen && !cmdOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (popoverOpen && omnibarRef.current && !omnibarRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
      if (cmdOpen && actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setCmdOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && cmdOpen) {
        setCmdOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [popoverOpen, cmdOpen]);

  const currentBranch = useMemo(() => branches.find((b) => b.isCurrent) ?? null, [branches]);
  const aheadCount = currentBranch?.ahead ?? 0;
  const behindCount = currentBranch?.behind ?? 0;

  const openCmdTab = (tab: CommandTab) => {
    if (cmdOpen && cmdTab === tab) {
      setCmdOpen(false);
      return;
    }
    setCmdTab(tab);
    setCmdOpen(true);
    setPopoverOpen(false);
  };

  const branchSuggestions = useMemo<SuggestionItem[]>(() => {
    const locals = branches.filter((b) => b.kind === "local");
    const remotes = branches.filter((b) => b.kind === "remote");
    return [
      ...locals.map((b) => ({
        value: b.name,
        label: b.name,
        meta: b.isCurrent ? "当前" : "本地",
      })),
      ...remotes.map((b) => ({
        value: b.name,
        label: b.name,
        meta: "远程",
      })),
    ];
  }, [branches]);

  const authorSuggestions = useMemo<SuggestionItem[]>(() => {
    const seen = new Map<string, string>();
    for (const row of graphRows) {
      const name = row.commit.authorName;
      if (!seen.has(name)) {
        seen.set(name, row.commit.authorEmail);
      }
    }
    return Array.from(seen.entries()).map(([name, email]) => ({
      value: name,
      label: name,
      meta: email,
    }));
  }, [graphRows]);

  const activeQuery = isPrefixCommand ? search.slice(1).trim().toLowerCase() : "";
  const activeList = useMemo(() => {
    const source = popoverTab === "author" ? authorSuggestions : branchSuggestions;
    return source
      .filter((item) => !activeQuery || item.label.toLowerCase().includes(activeQuery))
      .slice(0, 30);
  }, [popoverTab, authorSuggestions, branchSuggestions, activeQuery]);

  useEffect(() => {
    setActiveIndex(0);
  }, [popoverTab, activeQuery, popoverOpen]);

  const selectSuggestion = (item: SuggestionItem) => {
    if (popoverTab === "author") {
      setAuthor((prev) => (prev === item.value ? "" : item.value));
    } else {
      setBranch((prev) => (prev === item.value ? "" : item.value));
    }
    if (isPrefixCommand) {
      setSearch("");
    }
    setPopoverOpen(false);
    searchInputRef.current?.focus();
  };

  const togglePopoverTab = (tab: PopoverTab) => {
    if (popoverOpen && popoverTab === tab) {
      setPopoverOpen(false);
      return;
    }
    setPopoverTab(tab);
    setPopoverOpen(true);
    searchInputRef.current?.focus();
  };

  const handleInputChange = (val: string) => {
    setSearch(val);
    if (val.startsWith("@")) {
      setPopoverTab("author");
      setPopoverOpen(true);
    } else if (val.startsWith("#")) {
      setPopoverTab("branch");
      setPopoverOpen(true);
    } else if (isPrefixCommand) {
      setPopoverOpen(false);
    }
  };

  const clearAll = () => {
    setSearch("");
    setAuthor("");
    setBranch("");
    setSinceDate("");
    setUntilDate("");
    setPopoverOpen(false);
    searchInputRef.current?.focus();
  };

  const applyDatePreset = (daysBack: number | "month" | "clear") => {
    if (daysBack === "clear") {
      setSinceDate("");
      setUntilDate("");
      return;
    }
    const now = new Date();
    const todayStr = formatLocalDateInput(now);
    if (daysBack === "month") {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      setSinceDate(formatLocalDateInput(monthStart));
      setUntilDate(todayStr);
      return;
    }
    const start = new Date(now);
    start.setDate(start.getDate() - daysBack);
    setSinceDate(formatLocalDateInput(start));
    setUntilDate(todayStr);
  };

  const hasDateFilter = Boolean(sinceDate || untilDate);
  const hasAnyFilter = Boolean(search || author || branch || hasDateFilter);

  return (
    <section className="gitlog" aria-label="提交历史">
      <div className="gitlog-toolbar">
        <div
          ref={omnibarRef}
          className={`gitlog-omnibar${hasAnyFilter ? " has-filter" : ""}${popoverOpen ? " is-open" : ""}`}
          role="search"
          aria-label="筛选提交历史"
          onClick={() => searchInputRef.current?.focus()}
        >
          <SearchIcon className="gitlog-omnibar-icon" />

          {author && (
            <span className="gitlog-token">
              <UserIcon className="gitlog-token-icon" />
              <span className="gitlog-token-text" title={`作者: ${author}`}>
                {author}
              </span>
              <button
                type="button"
                className="gitlog-token-remove"
                aria-label="移除作者过滤"
                onClick={(e) => {
                  e.stopPropagation();
                  setAuthor("");
                  searchInputRef.current?.focus();
                }}
              >
                <CloseIcon />
              </button>
            </span>
          )}

          {branch && (
            <span className="gitlog-token">
              <BranchIcon className="gitlog-token-icon" />
              <span className="gitlog-token-text" title={`分支: ${branch}`}>
                {branch}
              </span>
              <button
                type="button"
                className="gitlog-token-remove"
                aria-label="移除分支过滤"
                onClick={(e) => {
                  e.stopPropagation();
                  setBranch("");
                  searchInputRef.current?.focus();
                }}
              >
                <CloseIcon />
              </button>
            </span>
          )}

          {hasDateFilter && (
            <span className="gitlog-token gitlog-token--date">
              <CalendarIcon className="gitlog-token-icon" />
              <span
                className="gitlog-token-text"
                title={`日期范围: ${formatDatePill(sinceDate, untilDate)}`}
              >
                {formatDatePill(sinceDate, untilDate)}
              </span>
              <button
                type="button"
                className="gitlog-token-remove"
                aria-label="移除日期过滤"
                onClick={(e) => {
                  e.stopPropagation();
                  setSinceDate("");
                  setUntilDate("");
                  searchInputRef.current?.focus();
                }}
              >
                <CloseIcon />
              </button>
            </span>
          )}

          <input
            ref={searchInputRef}
            type="search"
            className="gitlog-omnibar-input"
            placeholder={
              author || branch || hasDateFilter
                ? "继续输入关键词…"
                : "搜索提交、哈希，或输入 @作者  #分支…"
            }
            aria-label="搜索提交历史"
            aria-keyshortcuts="Meta+F Control+F"
            aria-expanded={popoverOpen}
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (popoverOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIndex((i) => (activeList.length > 0 ? (i + 1) % activeList.length : 0));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex((i) =>
                    activeList.length > 0 ? (i - 1 + activeList.length) % activeList.length : 0,
                  );
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const target = activeList[activeIndex];
                  if (target) {
                    selectSuggestion(target);
                  } else if (isPrefixCommand && activeQuery) {
                    const raw = search.slice(1).trim();
                    if (popoverTab === "author") setAuthor(raw);
                    else setBranch(raw);
                    setSearch("");
                    setPopoverOpen(false);
                  }
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setPopoverOpen(false);
                  return;
                }
              }

              if (e.key === "Backspace" && !search) {
                if (hasDateFilter) {
                  e.preventDefault();
                  setSinceDate("");
                  setUntilDate("");
                } else if (branch) {
                  e.preventDefault();
                  setBranch("");
                } else if (author) {
                  e.preventDefault();
                  setAuthor("");
                }
                return;
              }

              if (e.key === "Escape" && hasAnyFilter) {
                e.stopPropagation();
                clearAll();
              }
            }}
          />

          <div className="gitlog-omnibar-tools" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`gitlog-omni-tool${popoverOpen && popoverTab === "author" ? " is-active" : ""}${author ? " is-applied" : ""}`}
              aria-label="按作者筛选"
              title="按作者筛选 (@)"
              onClick={() => togglePopoverTab("author")}
            >
              <UserIcon />
            </button>
            <button
              type="button"
              className={`gitlog-omni-tool${popoverOpen && popoverTab === "branch" ? " is-active" : ""}${branch ? " is-applied" : ""}`}
              aria-label="按分支筛选"
              title="按分支筛选 (#)"
              onClick={() => togglePopoverTab("branch")}
            >
              <BranchIcon />
            </button>
            <button
              type="button"
              className={`gitlog-omni-tool${popoverOpen && popoverTab === "date" ? " is-active" : ""}${hasDateFilter ? " is-applied" : ""}`}
              aria-label="按日期范围筛选"
              title="按日期范围筛选"
              onClick={() => togglePopoverTab("date")}
            >
              <CalendarIcon />
            </button>

            {hasAnyFilter ? (
              <button
                type="button"
                className="gitlog-omni-clear"
                aria-label="清空所有搜索与筛选"
                title="清空筛选"
                onClick={clearAll}
              >
                <CloseIcon />
              </button>
            ) : (
              <kbd className="gitlog-search-hint" aria-hidden="true">
                {SEARCH_SHORTCUT}
              </kbd>
            )}
          </div>

          {popoverOpen && (
            <div
              className="gitlog-omni-popover"
              role="listbox"
              aria-label={popoverTab === "author" ? "作者候选" : "分支候选"}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="gitlog-omni-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={popoverTab === "author"}
                  className={`gitlog-omni-tab${popoverTab === "author" ? " is-active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setPopoverTab("author")}
                >
                  <UserIcon />
                  <span>作者</span>
                  <kbd>@</kbd>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={popoverTab === "branch"}
                  className={`gitlog-omni-tab${popoverTab === "branch" ? " is-active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setPopoverTab("branch")}
                >
                  <BranchIcon />
                  <span>分支</span>
                  <kbd>#</kbd>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={popoverTab === "date"}
                  className={`gitlog-omni-tab${popoverTab === "date" ? " is-active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setPopoverTab("date")}
                >
                  <CalendarIcon />
                  <span>日期</span>
                </button>
              </div>
              {popoverTab === "date" ? (
                <div className="gitlog-omni-date" role="group" aria-label="按日期范围筛选">
                  <div className="gitlog-omni-date-presets">
                    <button
                      type="button"
                      className="gitlog-omni-date-chip"
                      onClick={() => applyDatePreset(0)}
                    >
                      今天
                    </button>
                    <button
                      type="button"
                      className="gitlog-omni-date-chip"
                      onClick={() => applyDatePreset(6)}
                    >
                      最近 7 天
                    </button>
                    <button
                      type="button"
                      className="gitlog-omni-date-chip"
                      onClick={() => applyDatePreset(29)}
                    >
                      最近 30 天
                    </button>
                    <button
                      type="button"
                      className="gitlog-omni-date-chip"
                      onClick={() => applyDatePreset("month")}
                    >
                      本月
                    </button>
                    {hasDateFilter && (
                      <button
                        type="button"
                        className="gitlog-omni-date-chip is-clear"
                        onClick={() => applyDatePreset("clear")}
                      >
                        清空
                      </button>
                    )}
                  </div>
                  <div className="gitlog-omni-date-inputs">
                    <label className="gitlog-omni-date-field">
                      <span>起始日期</span>
                      <input
                        type="date"
                        aria-label="起始日期"
                        value={sinceDate}
                        onChange={(e) => setSinceDate(e.target.value)}
                      />
                    </label>
                    <span className="gitlog-omni-date-sep" aria-hidden="true">
                      →
                    </span>
                    <label className="gitlog-omni-date-field">
                      <span>结束日期</span>
                      <input
                        type="date"
                        aria-label="结束日期"
                        value={untilDate}
                        onChange={(e) => setUntilDate(e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <div className="gitlog-omni-list">
                  {activeList.length > 0 ? (
                    activeList.map((item, idx) => {
                      const selected = (popoverTab === "author" ? author : branch) === item.value;
                      const active = idx === activeIndex;
                      return (
                        <button
                          key={item.value}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`gitlog-omni-option${active ? " is-active" : ""}${selected ? " is-selected" : ""}`}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => selectSuggestion(item)}
                        >
                          <span className="gitlog-omni-option-label">{item.label}</span>
                          {item.meta && (
                            <span className="gitlog-omni-option-meta">{item.meta}</span>
                          )}
                          {selected && <CheckIcon className="gitlog-omni-option-check" />}
                        </button>
                      );
                    })
                  ) : (
                    <div className="gitlog-omni-empty">
                      {popoverTab === "author" ? "暂无匹配的作者" : "暂无匹配的分支"}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="gitlog-actions-wrap" ref={actionsRef}>
          <span className={`gitlog-loading${graphLoading ? " is-visible" : ""}`} aria-live="polite">
            {graphLoading && (
              <>
                <span className="gitlog-loading-spinner" aria-hidden="true" />
                <span>更新中</span>
              </>
            )}
          </span>
          <div className="gitlog-action-group" role="group" aria-label="Git 操作入口">
            <button
              type="button"
              className={`gitlog-seg-btn gitlog-seg-cmd${cmdOpen ? " is-active" : ""}`}
              title="打开 Git 操作中心（获取、拉取、推送、分支/标签、贮藏、历史整理与重置）"
              aria-expanded={cmdOpen}
              onClick={() => openCmdTab(cmdOpen ? cmdTab : "sync")}
            >
              {gitBusy !== null ? <RefreshIcon className="is-spinning" /> : <TerminalIcon />}
              <span>
                {gitBusy === "fetch"
                  ? "获取中…"
                  : gitBusy === "pull"
                    ? "拉取中…"
                    : gitBusy === "push"
                      ? "推送中…"
                      : gitBusy === "rebase"
                        ? "整理中…"
                        : "Git 操作"}
              </span>
              {behindCount > 0 && (
                <span
                  className="gitlog-seg-badge is-behind"
                  title={`落后上游 ${behindCount} 个提交`}
                >
                  ↓{behindCount}
                </span>
              )}
              {aheadCount > 0 && (
                <span className="gitlog-seg-badge is-ahead" title={`领先上游 ${aheadCount} 个提交`}>
                  ↑{aheadCount}
                </span>
              )}
              {stashes.length > 0 && (
                <span className="gitlog-seg-badge" title={`工作区贮藏 ${stashes.length} 条`}>
                  <StashIcon />
                  {stashes.length}
                </span>
              )}
              <ChevronDownIcon className={`gitlog-seg-caret${cmdOpen ? " is-open" : ""}`} />
            </button>
          </div>
          {cmdOpen && (
            <GitCommandCenter
              activeTab={cmdTab}
              onTabChange={setCmdTab}
              onOpenRebase={() => setRebaseOpen(true)}
              onClose={() => setCmdOpen(false)}
            />
          )}
        </div>
      </div>

      <div className="gitlog-body">
        <CommitTable />
        {(selectedCommitId !== null || compareRange !== null) && (
          <CommitDetail onOpenRebase={() => setRebaseOpen(true)} />
        )}
      </div>
      {rebaseOpen && <RebaseModal onClose={() => setRebaseOpen(false)} />}
    </section>
  );
}
