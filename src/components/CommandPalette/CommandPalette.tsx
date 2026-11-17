/**
 * 命令面板（v0.6 / 6.4，⌘K）：跨命令 / 分支 / 仓库 / 视图的模糊搜索入口。
 *
 * - 打开时从 store 快照组装候选（Git 操作、分支切换、最近仓库、视图与设置）；
 * - 输入即时模糊过滤（keyboard/fuzzyMatch），↑↓ 选择、Enter 执行、Esc 关闭；
 * - 面板关闭后执行动作，避免与浮层键盘处理相互干扰。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/app";
import type { BranchInfo } from "../../types";
import {
  BranchIcon,
  CheckIcon,
  FolderOpenIcon,
  MergeIcon,
  MoonIcon,
  PullIcon,
  PushIcon,
  RefreshIcon,
  SettingsIcon,
  SunIcon,
  TerminalIcon,
  UndoIcon,
} from "../Icons";
import { refreshRepoState } from "../../keyboard/appActions";
import { fuzzyMatchAny } from "../../keyboard/fuzzyMatch";
import "./CommandPalette.css";

interface CommandItem {
  id: string;
  title: string;
  group: "Git 操作" | "分支" | "仓库" | "视图与设置";
  detail?: string;
  keywords?: string;
  danger?: boolean;
  icon: React.ReactNode;
  run: () => void;
}

/** 由当前仓库状态构建全部候选命令。 */
function buildCommands(): CommandItem[] {
  const s = useAppStore.getState();
  const items: CommandItem[] = [];

  // —— 视图与设置 ——
  items.push({
    id: "settings",
    title: "打开设置",
    group: "视图与设置",
    keywords: "settings preferences 配置 偏好",
    icon: <SettingsIcon />,
    run: () => s.openSettings(),
  });
  items.push({
    id: "theme",
    title: "切换深 / 浅主题",
    group: "视图与设置",
    keywords: "theme toggle dark light 主题 深色 浅色",
    icon: s.theme === "dark" ? <SunIcon /> : <MoonIcon />,
    run: () => s.toggleTheme(),
  });
  items.push({
    id: "open-repo",
    title: "打开仓库…",
    group: "视图与设置",
    keywords: "open repository clone 打开",
    icon: <FolderOpenIcon />,
    run: () => void s.openRepo(),
  });

  const repo = s.repo;
  if (repo) {
    items.push({
      id: "refresh",
      title: "刷新仓库状态",
      group: "Git 操作",
      keywords: "refresh reload 刷新",
      icon: <RefreshIcon />,
      run: refreshRepoState,
    });

    const remote = (label: string, keywords: string, run: () => void, danger = false) =>
      items.push({
        id: `git-${label}`,
        title: label,
        group: "Git 操作",
        keywords,
        danger,
        icon: <TerminalIcon />,
        run,
      });

    remote("拉取远程（fetch）", "fetch 获取", () => void s.fetchRemote());
    remote("拉取全部远程（fetch --all）", "fetch all 获取全部", () => void s.fetchAll());
    remote("拉取并合并（pull）", "pull 拉取", () => void s.pullRepo());
    remote("变基拉取（pull --rebase）", "pull rebase 变基拉取", () => void s.pullRebase());
    remote("推送（push）", "push 推送", () => void s.pushRepo());
    remote(
      "安全强推（--force-with-lease）",
      "force push lease 强推",
      () => void s.pushForceWithLease(),
    );
    remote("推送全部标签", "push tags 标签", () => void s.pushTags());
    remote("贮藏更改（stash）", "stash 贮藏", () => void s.stashPush());
    remote(
      "应用最近贮藏（stash pop）",
      "stash pop 弹出贮藏",
      () => void s.stashApply(0, true),
      true,
    );
    remote("整理最近提交（轻量 Rebase）", "rebase rewrite 整理", () => s.openRebaseModal());

    // —— 危险操作撤销（v0.8 / 8.5）：恢复到备份引用，本身也是改写操作 → danger ——
    for (const backup of s.safetyBackups.slice(0, 4)) {
      items.push({
        id: `undo-${backup.refName}`,
        title: `恢复危险操作前状态（${backup.refName} · ${backup.shortId} ${backup.summary}）`,
        group: "Git 操作",
        detail: "reset --hard 到备份引用",
        keywords: `undo backup restore 撤销 恢复 备份 ${backup.refName}`,
        danger: true,
        icon: <UndoIcon />,
        run: () => void s.resetHead(backup.fullRef, "hard"),
      });
    }

    // —— 分支切换 ——
    for (const b of s.branches) {
      if (b.isCurrent) continue;
      items.push({
        id: `branch-${b.name}`,
        title: `切换到 ${b.name}`,
        group: "分支",
        detail: branchDetail(b),
        keywords: `checkout branch switch 切换 ${b.name}`,
        icon: <BranchIcon />,
        run: () => void s.checkoutBranch(b.name),
      });
    }

    // —— 最近仓库 ——
    for (const r of s.recentRepos) {
      if (r.id === repo.id) continue;
      items.push({
        id: `repo-${r.id}`,
        title: `切换仓库 ${r.name}`,
        group: "仓库",
        detail: r.path,
        keywords: `switch repo repository 切换仓库 ${r.name}`,
        icon: <FolderOpenIcon />,
        run: () => void s.openRepo(r.path),
      });
    }
  }

  return items;
}

function branchDetail(b: BranchInfo): string | undefined {
  if (b.kind === "remote") return "远程分支";
  const parts: string[] = [];
  if (b.upstream) parts.push(`跟踪 ${b.upstream}`);
  if ((b.ahead ?? 0) > 0) parts.push(`↑${b.ahead}`);
  if ((b.behind ?? 0) > 0) parts.push(`↓${b.behind}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function CommandPalette() {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const closeCommandPalette = useAppStore((s) => s.closeCommandPalette);
  const branchesVersion = useAppStore((s) => s.branches);
  const backupsVersion = useAppStore((s) => s.safetyBackups);
  const reposVersion = useAppStore((s) => s.recentRepos);
  const repo = useAppStore((s) => s.repo);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时重置输入并聚焦；分支 / 仓库列表变化时重建候选。
  const commands = useMemo(
    () => (open ? buildCommands() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, repo?.id, branchesVersion, reposVersion, backupsVersion],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return commands.slice(0, 60);
    return commands
      .map((item, idx) => ({
        item,
        idx,
        score: fuzzyMatchAny(query, [item.title, item.keywords ?? "", item.detail ?? ""]),
      }))
      .filter((r) => r.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.idx - b.idx)
      .slice(0, 60)
      .map((r) => r.item);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 选中项滚动进入可视区。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered]);

  if (!open) return null;

  const execute = (item: CommandItem) => {
    closeCommandPalette();
    // 先关闭浮层再执行，避免动作打开的新浮层被本次关闭覆盖。
    requestAnimationFrame(() => item.run());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[activeIndex];
      if (item) execute(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeCommandPalette();
    }
  };

  let lastGroup: string | null = null;

  return (
    <div
      className="cmdk-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeCommandPalette();
      }}
    >
      <div className="cmdk">
        <div className="cmdk__input-row">
          <span className="cmdk__prompt" aria-hidden="true">
            <MergeIcon />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="cmdk__input"
            placeholder="搜索命令、分支、仓库…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          <kbd className="cmdk__esc">Esc</kbd>
        </div>
        <div className="cmdk__list" ref={listRef} role="listbox" aria-label="命令列表">
          {filtered.length === 0 ? (
            <div className="cmdk__empty">没有匹配的命令</div>
          ) : (
            filtered.map((item, i) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {showGroup && <div className="cmdk__group">{item.group}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    data-index={i}
                    className={`cmdk__item${i === activeIndex ? " is-active" : ""}${item.danger ? " is-danger" : ""}`}
                    onMouseMove={() => setActiveIndex(i)}
                    onClick={() => execute(item)}
                  >
                    <span className="cmdk__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="cmdk__title">{item.title}</span>
                    {item.detail && (
                      <span className="cmdk__detail" title={item.detail}>
                        {item.detail}
                      </span>
                    )}
                    {i === activeIndex && (
                      <span className="cmdk__enter-hint" aria-hidden="true">
                        <CheckIcon />↵
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="cmdk__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>↵</kbd> 执行
          </span>
          <span className="cmdk__footer-hint">
            <PullIcon /> 远程
            <PushIcon /> 推送
            <RefreshIcon /> 刷新
          </span>
        </div>
      </div>
    </div>
  );
}
