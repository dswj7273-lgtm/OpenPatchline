/**
 * 应用根组件：三区骨架（左侧栏 + 主区域）+ 顶栏（docs/06 §1）。
 *
 * - 无仓库时展示居中的“打开仓库”空状态；
 * - 主区域按 activeView 在 GitLogView / DiffView 间切换（docs/06 §1.2）；
 * - Escape 关闭 diff 返回提交列表（docs/06 §7）。
 */
import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import * as DiffViewModule from "./components/DiffView/DiffView";
import { GitLogView } from "./components/GitLogView/GitLogView";
import { BranchIcon, MoonIcon, SunIcon } from "./components/Icons";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { useAppStore } from "./store/app";

/*
 * DiffView 当前占位为默认导出，正式实现约定为命名导出 `DiffView`；
 * 这里做两种形态的兼容，避免占位期 / 替换后编译失败。
 */
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

  return (
    <button
      type="button"
      className={big ? "btn btn-primary btn-lg" : "btn top-bar-open"}
      disabled={opening}
      onClick={() => void onOpen()}
    >
      打开仓库
    </button>
  );
}

/** 顶栏：应用名 + 仓库名 + 当前分支 + 主题切换 + 打开仓库。 */
function TopBar() {
  const repo = useAppStore(s => s.repo);
  const theme = useAppStore(s => s.theme);
  const setTheme = useAppStore(s => s.setTheme);

  return (
    <header className="top-bar">
      <span className="top-bar-title">OpenPatchline</span>
      {repo && (
        <>
          <span className="top-bar-sep" aria-hidden="true" />
          <span className="top-bar-repo">{repo.name}</span>
          <span className="top-bar-branch">
            <BranchIcon />
            <span className="top-bar-branch-name">{repo.headBranch ?? "(detached)"}</span>
          </span>
          <span className="top-bar-path" title={repo.path}>
            {repo.path}
          </span>
        </>
      )}
      <span className="top-bar-spacer" />
      <button
        type="button"
        className="icon-btn top-bar-theme"
        aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
      <OpenRepoButton />
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
      <span className="error-text">{error}</span>
      <button type="button" className="icon-btn" aria-label="关闭错误提示" onClick={() => setHidden(true)}>
        ×
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
    <div className="repo-picker-overlay" role="dialog" aria-label="选择仓库">
      <div className="repo-picker">
        <h2 className="repo-picker-title">未找到 Git 仓库</h2>
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
                  <span className="repo-picker-name">{c.name}</span>
                  <span className="repo-picker-path">{c.path}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="repo-picker-desc">其直接子目录中也没有发现仓库。</p>
        )}
        <div className="repo-picker-actions">
          <button type="button" className="btn" disabled={opening} onClick={() => void onPick("")}>
            选择其他目录…
          </button>
          <button type="button" className="btn" disabled={opening} onClick={dismiss}>
            关闭
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

  // Escape：diff 视图返回提交列表。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useAppStore.getState().activeView === "diff") {
        goBackToLog();
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
        <main className="empty-state">
          <h1 className="empty-title">OpenPatchline</h1>
          <p className="empty-desc">打开一个 Git 仓库，浏览提交历史与代码变更</p>
          <OpenRepoButton big />
        </main>
        <RepoCandidateModal />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar />
      <ErrorStrip />
      <div className="app-body">
        <Sidebar />
        <main className="app-main">{activeView === "diff" ? <DiffView /> : <GitLogView />}</main>
      </div>
      <RepoCandidateModal />
    </div>
  );
}
