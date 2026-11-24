/**
 * v0.8 / 8.2 视图组件测试：Sidebar / CommitDetail / FileHistoryView / DiffView
 * 的渲染与关键交互（覆盖率验收 60% 的主力补充）。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { Sidebar } from "../components/Sidebar/Sidebar";
import { CommitDetail } from "../components/GitLogView/CommitDetail";
import { FileHistoryView } from "../components/FileHistoryView/FileHistoryView";
import { DiffView } from "../components/DiffView/DiffView";
import { useAppStore } from "../store/app";
import type { CommitGraphRow, FileDiffResult } from "../types";

// review 修复：全量 api mock 走共享工厂（新增 IPC 命令自动纳入）。
vi.mock("../api/client", async (importOriginal) => {
  const { createApiMock } = await import("./mockApi");
  return createApiMock(await importOriginal<typeof import("../api/client")>(), {
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
        onboardingDismissed: false,
      },
      fresh: false,
    }),
    setAppSettings: async (cfg) => cfg,
  });
});

// Worker 在 jsdom 不可用：mock 高亮客户端（同步空 token）。
vi.mock("../highlighter/workerClient", () => ({
  EMPTY_SIDE_TOKENS: { left: [], right: [], degraded: false },
  getCachedHighlight: vi.fn(() => null),
  requestHighlight: vi.fn(() => () => undefined),
}));

const mockedApi = vi.mocked(api);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

const baseRepo = {
  id: "/tmp/repo",
  path: "/tmp/repo",
  name: "repo",
  headBranch: "main",
  headCommit: "1111111",
  state: "clean" as const,
};

function graphRow(id: string, subject: string): CommitGraphRow {
  return {
    commit: {
      id,
      shortId: id.slice(0, 7),
      message: subject,
      authorName: "Alice",
      authorEmail: "a@b.c",
      timestamp: 1700000000,
      parentIds: [],
      refs: [],
      lane: 0,
      laneColor: 0,
    },
    laneIndex: 0,
    laneCount: 1,
    colorIndex: 0,
    connectionsAbove: [],
    connectionsBelow: [],
  };
}

const sampleDiff: FileDiffResult = {
  oldPath: "a.ts",
  newPath: "a.ts",
  changeType: "modified",
  isBinary: false,
  tooLarge: false,
  rows: [
    {
      left: { kind: "context", lineno: 1, content: "keep", charRanges: [] },
      right: { kind: "context", lineno: 1, content: "keep", charRanges: [] },
    },
    {
      left: { kind: "removed", lineno: 2, content: "old", charRanges: [] },
      right: { kind: "added", lineno: 2, content: "new", charRanges: [] },
    },
  ],
  changeRowIndices: [1],
  additions: 1,
  deletions: 1,
};

describe("Sidebar（v0.8 / 8.2）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({
      repo: baseRepo,
      branches: [
        {
          name: "main",
          kind: "local",
          isCurrent: true,
          ahead: 1,
          behind: 2,
          upstream: "origin/main",
          tipCommit: "1111111",
        },
      ],
      fileStatus: [
        { path: "a.ts", staged: "modified", unstaged: null, conflicted: false },
        { path: "b.ts", staged: null, unstaged: "modified", conflicted: false },
        { path: "c.ts", staged: null, unstaged: "untracked", conflicted: false },
      ],
      stashes: [],
      commitMetadata: {
        commitTemplate: null,
        gpgSignEnabled: false,
        signingKey: null,
        gpgFormat: "openpgp",
      },
      commitHistory: [],
      gitBusy: null,
      diffScope: null,
      diffFiles: [],
      activeView: "log",
      openFileDiff: vi.fn(async () => {}),
      openConflictFile: vi.fn(async () => {}),
      openFileBlame: vi.fn(async () => {}),
      stageFile: vi.fn(async () => {}),
      unstageFile: vi.fn(async () => {}),
      stageFiles: vi.fn(async () => {}),
      unstageFiles: vi.fn(async () => {}),
      discardFile: vi.fn(async () => {}),
      checkoutBranch: vi.fn(async () => {}),
      createCommit: vi.fn(async () => {}),
      amendCommit: vi.fn(async () => true),
    });
  });

  it("renders change groups (staged / workdir / untracked) with directory trees", () => {
    render(<Sidebar />);
    expect(screen.getByText("已暂存")).toBeInTheDocument();
    expect(screen.getByText("工作区更改")).toBeInTheDocument();
    expect(screen.getByText("未跟踪文件")).toBeInTheDocument();
    // 根级文件直接渲染（目录需手动展开）
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    // 提交信息输入框存在
    expect(screen.getByLabelText("提交信息")).toBeInTheDocument();
  });

  it("opens workdir diff on file click and supports per-group batch staging", () => {
    const openFileDiff = vi.fn(async () => {});
    useAppStore.setState({ openFileDiff });
    const stageFiles = vi.fn(async () => {});
    useAppStore.setState({ stageFiles });
    render(<Sidebar />);

    fireEvent.click(screen.getByText("b.ts"));
    expect(openFileDiff).toHaveBeenCalled();

    // 工作区分组标题旁的整组暂存按钮（未跟踪组默认折叠不计）
    const batch = screen.getByLabelText("暂存全部工作区更改");
    fireEvent.click(batch);
    expect(stageFiles).toHaveBeenCalledWith(["b.ts"]);
  });
});

describe("CommitDetail（v0.8 / 8.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      repo: baseRepo,
      selectedCommitId: "1111111",
      graphRows: [graphRow("1111111", "feat: subject line")],
      commitFiles: [
        { path: "src/a.ts", oldPath: null, changeType: "modified", additions: 3, deletions: 1 },
        { path: "src/b.ts", oldPath: null, changeType: "added", additions: 10, deletions: 0 },
      ],
      commitSignature: null,
      compareRange: null,
      rangeFiles: [],
      gitBusy: null,
      fileStatus: [],
      openFileDiff: vi.fn(async () => {}),
      openFileBlame: vi.fn(async () => {}),
      selectCommit: vi.fn(async () => {}),
      cherryPickCommit: vi.fn(async () => {}),
      revertCommit: vi.fn(async () => {}),
      createBranch: vi.fn(async () => true),
      createTag: vi.fn(async () => true),
      resetHead: vi.fn(async () => {}),
      restoreFileFromCommit: vi.fn(async () => true),
    });
  });

  it("renders message, file list with stats, and parent chips", async () => {
    mockedApi.listBranchesContaining.mockResolvedValueOnce(["main", "dev"]);
    render(<CommitDetail />);
    expect(screen.getByText("feat: subject line")).toBeInTheDocument();

    // 按目录分组：仓库根 + 压缩后的目录，文件只显示文件名
    expect(screen.getByRole("button", { name: "折叠 repo，2 个文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "折叠 src，2 个文件" })).toBeInTheDocument();
    expect(screen.getByTitle(/src\/a\.ts/)).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("+13")).toBeInTheDocument(); // 总计

    // 父提交芯片（无父提交不展示）与所在分支异步加载
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(screen.getByText("main", { selector: ".cd-branch-chip" })).toBeInTheDocument();
  });

  it("opens commit diff on file click and restores file via ↩ button", () => {
    const openFileDiff = vi.fn(async () => {});
    const restore = vi.fn(async () => true);
    useAppStore.setState({ openFileDiff, restoreFileFromCommit: restore });
    render(<CommitDetail />);

    fireEvent.click(screen.getByTitle(/src\/b\.ts/));
    expect(openFileDiff).toHaveBeenCalled();

    const restoreBtn = screen.getByLabelText("从该提交恢复 src/a.ts");
    fireEvent.click(restoreBtn);
    expect(restore).toHaveBeenCalledWith("1111111", "src/a.ts");
  });

  it("collapses a directory group and hides its files", () => {
    render(<CommitDetail />);
    fireEvent.click(screen.getByRole("button", { name: "折叠 src，2 个文件" }));
    expect(screen.queryByTitle(/src\/a\.ts/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/src\/b\.ts/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开 src，2 个文件" }));
    expect(screen.getByTitle(/src\/a\.ts/)).toBeInTheDocument();
  });
});

describe("FileHistoryView（v0.8 / 8.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      historyPath: "src/a.ts",
      historyLoading: false,
      historyEntries: [
        {
          commitId: "2222222",
          shortId: "2222222",
          authorName: "Bob",
          timestamp: Math.floor(Date.now() / 1000) - 60,
          summary: "fix: something",
          changeType: "modified",
          path: "src/a.ts",
          oldPath: null,
        },
        {
          commitId: "3333333",
          shortId: "3333333",
          authorName: "Amy",
          timestamp: Math.floor(Date.now() / 1000) - 86400 * 40,
          summary: "rename file",
          changeType: "renamed",
          path: "src/a.ts",
          oldPath: "src/old.ts",
        },
      ],
      openFileDiff: vi.fn(async () => {}),
      openFileBlame: vi.fn(async () => {}),
      selectCommit: vi.fn(async () => {}),
      restoreFileFromCommit: vi.fn(async () => true),
      closeFileHistory: vi.fn(),
    });
  });

  it("renders entries with rename annotation and opens diff on click", () => {
    const openFileDiff = vi.fn(async () => {});
    useAppStore.setState({ openFileDiff });
    render(<FileHistoryView />);
    expect(screen.getByText("fix: something")).toBeInTheDocument();
    expect(screen.getByText("src/old.ts → src/a.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/fix: something/));
    expect(openFileDiff).toHaveBeenCalledWith(
      { kind: "commit", commitId: "2222222" },
      expect.any(Array),
      0,
      expect.objectContaining({ returnView: "history" }),
    );
  });
});

describe("DiffView（v0.8 / 8.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      repo: baseRepo,
      activeView: "diff",
      diffScope: { kind: "commit", commitId: "1111111" },
      diffFiles: [
        { path: "a.ts", oldPath: null, changeType: "modified", additions: 1, deletions: 1 },
      ],
      selectedDiffFileIndex: 0,
      currentFileDiff: sampleDiff,
      diffLoading: false,
      fileStatus: [],
      gitBusy: null,
      compareRange: null,
      settings: {
        theme: "dark",
        codeFontFamily: "",
        codeFontSize: 13,
        tabWidth: 4,
        defaultDiffMode: "split",
        ignoreWhitespaceDefault: false,
        externalEditorCommand: null,
        gitExecutablePath: null,
        onboardingDismissed: false,
      },
      prevDiffFile: vi.fn(async () => {}),
      nextDiffFile: vi.fn(async () => {}),
      showDiffFile: vi.fn(async () => {}),
      goBackToLog: vi.fn(),
      applyDiffSelection: vi.fn(async () => true),
      openConflictFile: vi.fn(async () => {}),
      openFileBlame: vi.fn(async () => {}),
      setDiffIgnoreWhitespace: vi.fn(async () => {}),
    });
  });

  it("renders header stats, scope pill, and split rows", () => {
    render(<DiffView />);
    // 统计胶囊
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    // scope 胶囊（commit 短 id）
    expect(screen.getByText("1111111")).toBeInTheDocument();
    // 变更行内容渲染
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("toggles unified mode and jump-to-change via header buttons", () => {
    render(<DiffView />);
    fireEvent.click(screen.getByRole("button", { name: "统一" }));
    // 统一模式仍渲染行内容
    expect(screen.getByText("new")).toBeInTheDocument();

    // 下一处变更按钮可点（不抛错即通过）
    fireEvent.click(screen.getByLabelText("下一处变更"));
  });
});
