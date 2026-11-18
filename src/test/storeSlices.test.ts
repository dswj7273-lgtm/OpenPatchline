/**
 * v0.8 / 8.2：store 各 Slice 的行为测试（workflow / history / ui / settings /
 * appActions），配合 api mock 验证调用链、错误路径与状态复位。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { createAppStore } from "../store/app";
import type { RepoInfo } from "../types";

vi.mock("../api/client", () => ({
  openRepository: vi.fn(),
  getRepoInfo: vi.fn(async () => ({
    id: "/tmp/demo",
    path: "/tmp/demo",
    name: "demo",
    headBranch: "main",
    headCommit: "1111111",
    state: "clean" as const,
  })),
  getRecentRepositories: vi.fn(async () => []),
  removeRecentRepository: vi.fn(async () => []),
  getCommitGraph: vi.fn(async () => ({ rows: [], nextCursor: null, hasMore: false })),
  getCommitFiles: vi.fn(async () => []),
  getRangeFiles: vi.fn(async () => []),
  getFileDiff: vi.fn(),
  applyDiffSelection: vi.fn(async () => {}),
  getFileStatus: vi.fn(async () => []),
  stageFile: vi.fn(async () => {}),
  unstageFile: vi.fn(async () => {}),
  createCommit: vi.fn(async () => "abc1234"),
  getCommitMetadata: vi.fn(async () => ({
    commitTemplate: null,
    gpgSignEnabled: false,
    signingKey: null,
    gpgFormat: "openpgp",
  })),
  getCommitSignature: vi.fn(async () => ({
    commitId: "1111111",
    status: "unsigned",
    signer: null,
    keyId: null,
  })),
  listRebaseCommits: vi.fn(async () => []),
  interactiveRebase: vi.fn(),
  listBranches: vi.fn(async () => []),
  checkoutBranch: vi.fn(),
  fetchRepository: vi.fn(),
  pullRepository: vi.fn(),
  pushRepository: vi.fn(),
  fetchAllRemotes: vi.fn(),
  pullRebaseRepository: vi.fn(),
  pushForceWithLeaseRepository: vi.fn(),
  pushTagsRepository: vi.fn(),
  cancelRemoteOperation: vi.fn(async () => true),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  mergeBranch: vi.fn(),
  abortOperation: vi.fn(),
  continueOperation: vi.fn(),
  createTag: vi.fn(),
  cherryPickCommit: vi.fn(),
  revertCommit: vi.fn(),
  resetHead: vi.fn(),
  discardFile: vi.fn(),
  discardAll: vi.fn(),
  amendCommit: vi.fn(),
  listStashes: vi.fn(async () => []),
  stashPush: vi.fn(),
  stashApply: vi.fn(),
  stashDrop: vi.fn(),
  stashBranch: vi.fn(),
  getStashFiles: vi.fn(),
  checkoutFileFrom: vi.fn(),
  listBranchesContaining: vi.fn(async () => []),
  listSafetyBackups: vi.fn(async () => []),
  getFileHistory: vi.fn(async () => []),
  getConflictFile: vi.fn(),
  resolveConflictFile: vi.fn(),
  getFileBlame: vi.fn(),
  logClientError: vi.fn(async () => {}),
  getLogFilePath: vi.fn(async () => "/tmp/openpatchline.log"),
  getAppSettings: vi.fn(async () => ({
    config: {
      theme: "system",
      codeFontFamily: "",
      codeFontSize: 13,
      tabWidth: 4,
      defaultDiffMode: "split",
      ignoreWhitespaceDefault: false,
      externalEditorCommand: null,
      gitExecutablePath: null,
    },
    fresh: false,
  })),
  setAppSettings: vi.fn(async (cfg) => cfg),
  revealPathInFinder: vi.fn(),
  openFileInEditor: vi.fn(),
  generateFilePatch: vi.fn(),
  pickGitExecutable: vi.fn(),
  getDiagnostics: vi.fn(),
  revealLogFile: vi.fn(),
}));

const mockedApi = vi.mocked(api);
const baseRepo: RepoInfo = {
  id: "/tmp/demo",
  path: "/tmp/demo",
  name: "demo",
  headBranch: "main",
  headCommit: "1111111",
  state: "clean",
};

describe("workspaceSlice（v0.8 / 8.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function openStore() {
    const store = createAppStore();
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");
    return store;
  }

  it("stageFiles batches staging then refreshes status once", async () => {
    const store = await openStore();
    mockedApi.getFileStatus.mockResolvedValue([
      { path: "a.ts", staged: "modified", unstaged: null, conflicted: false },
      { path: "b.ts", staged: "modified", unstaged: null, conflicted: false },
    ]);
    await store.getState().stageFiles(["a.ts", "b.ts"]);
    expect(mockedApi.stageFile).toHaveBeenCalledTimes(2);
    expect(store.getState().fileStatus).toHaveLength(2);
  });

  it("checkout success resets selection and reloads graph/branches", async () => {
    const store = await openStore();
    const info: RepoInfo = { ...baseRepo, headBranch: "dev" };
    mockedApi.checkoutBranch.mockResolvedValueOnce(info);
    await store.getState().checkoutBranch("dev");
    expect(mockedApi.checkoutBranch).toHaveBeenCalledWith("/tmp/demo", "dev");
    expect(store.getState().repo?.headBranch).toBe("dev");
    expect(store.getState().notice).toContain("dev");
    // logFilter.branch 被重置
    expect(store.getState().logFilter.branch).toBeNull();
  });

  it("createCommit refreshes repo info / graph / branches and records history", async () => {
    const store = await openStore();
    await store.getState().createCommit("feat: x");
    expect(mockedApi.createCommit).toHaveBeenCalledWith("/tmp/demo", "feat: x");
    expect(mockedApi.getCommitGraph).toHaveBeenCalled();
    expect(store.getState().commitHistory[0]).toBe("feat: x");
  });

  it("runExclusive blocks concurrent operations and surfaces errors", async () => {
    const store = await openStore();
    mockedApi.fetchRepository.mockResolvedValueOnce({
      remote: "origin",
      output: "up to date",
    });
    const p = store.getState().fetchRemote();
    // 进行中：第二个操作被互斥跳过（pullRepository 不会被调用）
    await store.getState().pullRepo();
    expect(mockedApi.pullRepository).not.toHaveBeenCalled();
    await p;
    expect(store.getState().notice).toContain("origin");

    // 失败路径：错误写入 error 且 notice 清空
    mockedApi.pushRepository.mockRejectedValueOnce(new Error("network down"));
    await store.getState().pushRepo();
    expect(store.getState().error).toContain("network down");
  });

  it("stashApply refreshes stashes after success", async () => {
    const store = await openStore();
    mockedApi.stashApply.mockResolvedValueOnce({
      output: "ok",
      repo: baseRepo,
    });
    await store.getState().stashApply(0, true);
    expect(mockedApi.stashApply).toHaveBeenCalledWith("/tmp/demo", 0, true);
    expect(mockedApi.listStashes).toHaveBeenCalled();
  });

  it("restoreFileFromCommit refuses dirty files to avoid silent overwrite", async () => {
    const store = await openStore();
    store.setState({
      fileStatus: [{ path: "a.ts", staged: null, unstaged: "modified", conflicted: false }],
    });
    const ok = await store.getState().restoreFileFromCommit("1111111", "a.ts");
    expect(ok).toBe(false);
    expect(mockedApi.checkoutFileFrom).not.toHaveBeenCalled();
    expect(store.getState().error).toContain("存在未提交修改");

    // 干净文件 → 执行恢复并刷新状态
    store.setState({ fileStatus: [] });
    mockedApi.getFileStatus.mockResolvedValueOnce([]);
    const ok2 = await store.getState().restoreFileFromCommit("1111111", "a.ts");
    expect(ok2).toBe(true);
    expect(mockedApi.checkoutFileFrom).toHaveBeenCalledWith("/tmp/demo", "1111111", "a.ts");
  });
});

describe("historySlice / uiSlice / logSlice focus（v0.8 / 8.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("openFileHistory loads entries and guards stale responses", async () => {
    const store = createAppStore();
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");

    mockedApi.getFileHistory.mockResolvedValueOnce([
      {
        commitId: "2222222",
        shortId: "2222222",
        authorName: "A",
        timestamp: 1,
        summary: "s",
        changeType: "modified",
        path: "a.ts",
        oldPath: null,
      },
    ]);
    await store.getState().openFileHistory("a.ts");
    expect(store.getState().activeView).toBe("history");
    expect(store.getState().historyEntries).toHaveLength(1);
    expect(store.getState().historyLoading).toBe(false);

    store.getState().closeFileHistory();
    expect(store.getState().activeView).toBe("log");
    expect(store.getState().historyPath).toBeNull();
  });

  it("uiSlice toggles overlays exclusively", () => {
    const store = createAppStore();
    store.getState().openSettings();
    expect(store.getState().settingsOpen).toBe(true);
    store.getState().openCommandPalette();
    expect(store.getState().commandPaletteOpen).toBe(true);
    expect(store.getState().settingsOpen).toBe(false); // 互斥
    store.getState().closeCommandPalette();
    expect(store.getState().commandPaletteOpen).toBe(false);
  });

  it("logSlice focusSearch increments tick for view focusing", () => {
    const store = createAppStore();
    const before = store.getState().searchFocusTick;
    store.getState().focusSearch();
    expect(store.getState().searchFocusTick).toBe(before + 1);
  });
});

describe("appActions（v0.8 / 8.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes refresh to reload everything when repo open", async () => {
    // appActions 操作全局单例 store：直接播种仓库状态
    const { useAppStore } = await import("../store/app");
    useAppStore.setState({ repo: baseRepo });
    const { runAppAction, refreshRepoState } = await import("../keyboard/appActions");
    refreshRepoState();
    // 异步刷新：等微任务落地
    await new Promise((r) => setTimeout(r, 10));
    expect(mockedApi.getRepoInfo).toHaveBeenCalled();
    expect(mockedApi.getFileStatus).toHaveBeenCalled();
    expect(mockedApi.getCommitGraph).toHaveBeenCalled();
    expect(mockedApi.listBranches).toHaveBeenCalled();

    // 未消费的动作返回 false；open-settings 消费并打开浮层
    expect(runAppAction("unknown-action")).toBe(false);
    expect(runAppAction("open-settings")).toBe(true);
    expect(useAppStore.getState().settingsOpen).toBe(true);
    useAppStore.setState({ repo: null, settingsOpen: false });
  });
});
