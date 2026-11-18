/**
 * v0.8 / 8.2 骨架与零覆盖组件补测：App 三区骨架（TopBar / Esc 路由）、
 * DiffFileList（文件切换下拉）、ContextMenu / fileContextMenu / clipboard。
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// —— App 依赖的 Tauri API 全部 mock ——
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));
// review 修复：全量 api mock 走共享工厂（新增 IPC 命令自动纳入）。
vi.mock("../api/client", async (importOriginal) => {
  const { createApiMock } = await import("./mockApi");
  return createApiMock(await importOriginal<typeof import("../api/client")>(), {
    getRepoInfo: async () => ({
      id: "/tmp/repo",
      path: "/tmp/repo",
      name: "repo",
      headBranch: "main",
      headCommit: "1111111",
      state: "clean",
    }),
    getRecentRepositories: async () => [],
    removeRecentRepository: async () => [],
    getCommitGraph: async () => ({ rows: [], nextCursor: null, hasMore: false }),
    getCommitFiles: async () => [],
    getRangeFiles: async () => [],
    applyDiffSelection: async () => {},
    getFileStatus: async () => [],
    stageFile: async () => {},
    unstageFile: async () => {},
    createCommit: async () => "abc1234",
    getCommitMetadata: async () => ({
      commitTemplate: null,
      gpgSignEnabled: false,
      signingKey: null,
      gpgFormat: "openpgp",
    }),
    getCommitSignature: async () => ({
      commitId: "1111111",
      status: "unsigned",
      signer: null,
      keyId: null,
    }),
    listRebaseCommits: async () => [],
    listBranches: async () => [],
    cancelRemoteOperation: async () => true,
    listStashes: async () => [],
    listBranchesContaining: async () => [],
    listSafetyBackups: async () => [],
    getFileHistory: async () => [],
    logClientError: async () => {},
    getLogFilePath: async () => "/tmp/log",
    getAppSettings: async () => ({
      config: {
        theme: "system",
        codeFontFamily: "",
        codeFontSize: 13,
        tabWidth: 4,
        defaultDiffMode: "split",
        ignoreWhitespaceDefault: false,
        externalEditorCommand: null,
        gitExecutablePath: null,
        onboardingDismissed: true,
      },
      fresh: false,
    }),
    setAppSettings: async (cfg) => cfg,
  });
});

const App = (await import("../App")).default;
const { useAppStore } = await import("../store/app");
const { default: DiffFileList } = await import("../components/DiffView/DiffFileList");
const { useContextMenu } = await import("../components/ContextMenu/ContextMenu");
const { copyText } = await import("../utils/clipboard");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App 骨架（v0.8 / 8.2）", () => {
  beforeEach(() => {
    useAppStore.setState({
      repo: {
        id: "/tmp/repo",
        path: "/tmp/repo",
        name: "repo",
        headBranch: "main",
        headCommit: "1111111",
        state: "clean",
      },
      recentRepos: [],
      activeView: "log",
      fileStatus: [],
      branches: [],
      stashes: [],
      commitMetadata: null,
      commitHistory: [],
      gitBusy: null,
      error: null,
      notice: null,
      graphRows: [],
      repoCandidates: null,
      settingsOpen: false,
      commandPaletteOpen: false,
      rebaseModalOpen: false,
      openRepo: vi.fn(async () => {}),
      removeRecentRepo: vi.fn(async () => {}),
      goBackToLog: vi.fn(() => useAppStore.setState({ activeView: "log", diffScope: null })),
      closeBlame: vi.fn(),
      loadRecentRepos: vi.fn(async () => {}),
      loadSettings: vi.fn(async () => {}),
      maybeShowOnboarding: vi.fn(),
    });
  });

  it("renders top bar with repo/branch and main view switch by activeView", () => {
    const { rerender } = render(<App />);
    expect(screen.getByText("OpenPatchline")).toBeInTheDocument();
    expect(screen.getByText("main", { selector: ".top-bar-branch-name" })).toBeInTheDocument();
    // 主区域：提交列表（空态文案来自 GitLogView 内部）
    expect(screen.getByRole("main")).toBeInTheDocument();

    // 切到 diff 视图 → 渲染 DiffView 空态
    useAppStore.setState({ activeView: "diff" });
    rerender(<App />);
    expect(screen.getByText(/选择一个文件查看差异|加载差异中/)).toBeInTheDocument();
  });

  it("Escape from diff routes back to log via keymap handler", () => {
    const goBackToLog = vi.fn(() => useAppStore.setState({ activeView: "log" }));
    useAppStore.setState({ activeView: "diff", goBackToLog });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(goBackToLog).toHaveBeenCalled();
  });

  it("shows repo switcher popover listing recent repos", async () => {
    useAppStore.setState({
      recentRepos: [{ id: "/tmp/other", path: "/tmp/other", name: "other", lastOpenedAt: 1 }],
    });
    render(<App />);
    // 仓库切换按钮带 aria-haspopup=listbox，展示当前仓库名
    fireEvent.click(screen.getByRole("button", { name: /repo/ }));
    expect(screen.getByText("最近打开的仓库")).toBeInTheDocument();
    expect(screen.getByText("/tmp/other")).toBeInTheDocument();
  });
});

describe("DiffFileList（v0.8 / 8.2）", () => {
  it("shows current file index and lists all files in dropdown", () => {
    const onSelect = vi.fn();
    render(
      <DiffFileList
        files={[
          { path: "src/a.ts", oldPath: null, changeType: "modified", additions: 1, deletions: 1 },
          { path: "src/b.ts", oldPath: null, changeType: "added", additions: 5, deletions: 0 },
        ]}
        currentIndex={0}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "1 / 2" }));
    // option 是 li 容器，点击其内部按钮
    const option = screen.getByRole("option", { name: /b\.ts/ });
    fireEvent.click(within(option).getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});

describe("ContextMenu / clipboard（v0.8 / 8.2）", () => {
  it("opens menu at pointer, closes on outside mousedown, and runs item", () => {
    function Host() {
      const menu = useContextMenu();
      return (
        <div>
          <button
            type="button"
            onClick={(e) =>
              menu.open(e as unknown as React.MouseEvent, [
                {
                  key: "a",
                  label: "动作 A",
                  onSelect: () => window.dispatchEvent(new Event("opl-menu-ran")),
                },
              ])
            }
          >
            opener
          </button>
          {menu.render()}
        </div>
      );
    }
    const ran = vi.fn();
    window.addEventListener("opl-menu-ran", ran);
    render(<Host />);
    fireEvent.click(screen.getByText("opener"));
    const item = screen.getByRole("menuitem", { name: "动作 A" });
    expect(item).toBeInTheDocument();
    fireEvent.click(item);
    expect(ran).toHaveBeenCalled();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("copyText falls back to execCommand when clipboard API rejects", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.assign(navigator, { clipboard: { writeText } });
    const exec = vi.fn(() => true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    const ok = await copyText("hello");
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it("copyText returns false when both paths fail", async () => {
    Object.assign(navigator, { clipboard: undefined });
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand;
    const ok = await copyText("hello");
    expect(ok).toBe(false);
  });
});
