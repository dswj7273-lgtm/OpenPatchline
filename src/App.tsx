/**
 * 应用根组件：三区骨架（左侧栏 + 主区域）+ 顶栏（docs/06 §1）。
 *
 * - 无仓库时展示居中的现代欢迎页与“打开仓库”入口；
 * - 主区域按 activeView 在 GitLogView / DiffView 间切换（docs/06 §1.2）；
 * - Escape 关闭弹层或从 diff 返回提交列表；Cmd/Ctrl+O 打开仓库，Cmd/Ctrl+Shift+T 切换主题。
 */
import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { listen } from "@tauri-apps/api/event";
import * as DiffViewModule from "./components/DiffView/DiffView";
import { GitLogView } from "./components/GitLogView/GitLogView";
import {
  AlertIcon,
  BranchIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderOpenIcon,
  LogoMarkIcon,
  MoonIcon,
  SunIcon,
} from "./components/Icons";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { useAppStore } from "./store/app";

const OPEN_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘ O" : "Ctrl O";
const THEME_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘⇧T" : "Ctrl+Shift+T";

const diffViewModule = DiffViewModule as unknown as {
  DiffView?: ComponentType;
  default?: ComponentType;
};
const DiffView = diffViewModule.DiffView ?? diffViewModule.default ?? (() => null);

/** 打开仓库按钮（原生目录选择框由 Rust 侧弹出）。 */
function OpenRepoButton({ big }: { big?: boolean }) {
  const openRepo = useAppStore(s => s.openRepo);
  const [opening, setOpening] = useState(false);

  const onOpen = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openRepo();
    } finally {
      setOpening(false);
    }
  };

  if (big) {
    return (
      <button
        type="button"
        className="btn btn-primary btn-lg empty-cta"
        disabled={opening}
        onClick={() => void onOpen()}
      >
        <FolderOpenIcon />
        <span>{opening ? "正在打开…" : "打开 Git 仓库"}</span>
        <kbd className="empty-cta-kbd" aria-hidden="true">{OPEN_SHORTCUT}</kbd>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn top-bar-open"
      disabled={opening}
      title={`打开仓库 (${OPEN_SHORTCUT})`}
      onClick={() => void onOpen()}
    >
      <FolderOpenIcon />
      <span className="top-bar-open-label">{opening ? "打开中…" : "打开仓库"}</span>
    </button>
  );
}

/** 顶栏：品牌标识 + 仓库上下文面包屑 + 主题切换 + 打开仓库。 */
function TopBar() {
  const repo = useAppStore(s => s.repo);
  const theme = useAppStore(s => s.theme);
  const setTheme = useAppStore(s => s.setTheme);

  const toggleThemeLabel =
    theme === "dark" ? `切换到浅色主题 (${THEME_SHORTCUT})` : `切换到深色主题 (${THEME_SHORTCUT})`;

  return (
    <header className="top-bar">
      <div className="top-bar-brand">
        <span className="top-bar-logo" aria-hidden="true">
          <LogoMarkIcon />
        </span>
        <span className="top-bar-title">OpenPatchline</span>
      </div>
      {repo && (
        <>
          <span className="top-bar-sep" aria-hidden="true" />
          <div className="top-bar-context">
            <span className="top-bar-repo">{repo.name}</span>
            <span className="top-bar-branch" title={repo.headBranch ?? "分离 HEAD"}>
              <BranchIcon />
              <span className="top-bar-branch-name">{repo.headBranch ?? "(detached)"}</span>
            </span>
          </div>
          <span className="top-bar-path" title={repo.path}>
            {repo.path}
          </span>
        </>
      )}
      <span className="top-bar-spacer" />
      <div className="top-bar-actions">
        <button
          type="button"
          className="icon-btn top-bar-theme"
          aria-label={toggleThemeLabel}
          title={toggleThemeLabel}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <OpenRepoButton />
      </div>
    </header>
  );
}

/** 错误提示条；store 无 clearError 动作，隐藏状态在组件内本地维护。 */
function ErrorStrip() {
  const error = useAppStore(s => s.error);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
  }, [error]);

  if (!error || hidden) return null;
  return (
    <div className="error-strip" role="alert">
      <AlertIcon className="strip-icon" />
      <span className="error-text">{error}</span>
      <button
        type="button"
        className="icon-btn strip-close"
        aria-label="关闭错误提示"
        onClick={() => setHidden(true)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/** 成功提示条（拉取完成等）；与 ErrorStrip 同构，手动关闭。 */
function NoticeStrip() {
  const notice = useAppStore(s => s.notice);
  const dismissNotice = useAppStore(s => s.dismissNotice);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
  }, [notice]);

  if (!notice || hidden) return null;
  return (
    <div className="notice-strip" role="status">
      <CheckCircleIcon className="strip-icon" />
      <span className="notice-text">{notice}</span>
      <button
        type="button"
        className="icon-btn strip-close"
        aria-label="关闭提示"
        onClick={() => {
          setHidden(true);
          dismissNotice();
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/** 「所选目录不是仓库」弹层：列出直接子目录中的仓库供选择。 */
function RepoCandidateModal() {
  const repoCandidates = useAppStore(s => s.repoCandidates);
  const openRepo = useAppStore(s => s.openRepo);
  const dismiss = useAppStore(s => s.dismissRepoCandidates);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!repoCandidates) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [repoCandidates, dismiss]);

  if (!repoCandidates) return null;

  const onPick = async (path: string) => {
    if (opening) return;
    setOpening(true);
    try {
      await openRepo(path);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div
      className="repo-picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="选择仓库"
      onClick={e => {
        if (e.target === e.currentTarget && !opening) dismiss();
      }}
    >
      <div className="repo-picker">
        <div className="repo-picker-header">
          <h2 className="repo-picker-title">未找到 Git 仓库</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            disabled={opening}
            onClick={dismiss}
          >
            <CloseIcon />
          </button>
        </div>
        <p className="repo-picker-desc" title={repoCandidates.path}>
          {repoCandidates.path} 本身不是 Git 仓库
          {repoCandidates.candidates.length > 0 ? "，但它包含以下仓库：" : ""}
        </p>
        {repoCandidates.candidates.length > 0 ? (
          <ul className="repo-picker-list">
            {repoCandidates.candidates.map(c => (
              <li key={c.path}>
                <button
                  type="button"
                  className="repo-picker-item"
                  disabled={opening}
                  onClick={() => void onPick(c.path)}
                >
                  <span className="repo-picker-item-icon" aria-hidden="true">
                    <FolderOpenIcon />
                  </span>
                  <span className="repo-picker-item-copy">
                    <span className="repo-picker-name">{c.name}</span>
                    <span className="repo-picker-path">{c.path}</span>
                  </span>
                  <ChevronRightIcon className="repo-picker-chevron" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="repo-picker-desc">其直接子目录中也没有发现仓库。</p>
        )}
        <div className="repo-picker-actions">
          <button type="button" className="btn" disabled={opening} onClick={dismiss}>
            关闭
          </button>
          <button type="button" className="btn btn-primary" disabled={opening} onClick={() => void onPick("")}>
            选择其他目录…
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const repo = useAppStore(s => s.repo);
  const activeView = useAppStore(s => s.activeView);
  const theme = useAppStore(s => s.theme);
  const goBackToLog = useAppStore(s => s.goBackToLog);

  // 主题落到 <html data-theme>，驱动 theme.css 的令牌覆盖。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 仓库变更监听（Rust notify 监听 .git，防抖后推送）：外部操作后自动刷新。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<string>("repo_status_changed", (event) => {
      const state = useAppStore.getState();
      if (!state.repo || event.payload !== state.repo.id) return;
      if (state.gitBusy !== null) return;
      void state.loadFileStatus();
      void state.reloadGraph();
      void state.loadBranches();
    }).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 全局快捷键：Escape 返回列表，Cmd/Ctrl+O 打开仓库，Cmd/Ctrl+Shift+T 切换主题。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useAppStore.getState();
      if (e.key === "Escape" && !state.repoCandidates && state.activeView === "diff") {
        goBackToLog();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void state.openRepo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        state.setTheme(state.theme === "dark" ? "light" : "dark");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBackToLog]);

  if (!repo) {
    return (
      <div className="app-shell">
        <TopBar />
        <ErrorStrip />
        <NoticeStrip />
        <main className="empty-state">
          <div className="empty-card">
            <div className="empty-emblem" aria-hidden="true">
              <LogoMarkIcon />
            </div>
            <div className="empty-copy">
              <h1 className="empty-title">OpenPatchline</h1>
              <p className="empty-desc">
                轻量、克制、以代码阅读为中心的 Git 工作台
                <br />
                浏览提交泳道图、审查双栏字符级差异与管理暂存区
              </p>
            </div>
            <OpenRepoButton big />
            <div className="empty-features" aria-hidden="true">
              <span className="empty-feature-pill">
                <span className="empty-feature-dot" />
                泳道提交图
              </span>
              <span className="empty-feature-pill">
                <span className="empty-feature-dot" />
                双栏字符级 Diff
              </span>
              <span className="empty-feature-pill">
                <span className="empty-feature-dot" />
                实时工作区监听
              </span>
            </div>
          </div>
        </main>
        <RepoCandidateModal />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar />
      <ErrorStrip />
      <NoticeStrip />
      <div className="app-body">
        <Sidebar />
        <main className="app-main">{activeView === "diff" ? <DiffView /> : <GitLogView />}</main>
      </div>
      <RepoCandidateModal />
    </div>
  );
}
