import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { createAppStore } from "../store/app";
import type { ChangedFile, FileDiffResult, RepoInfo } from "../types";

vi.mock("../api/client", () => ({
  openRepository: vi.fn(),
  getRepoInfo: vi.fn(),
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
  rewriteRecentCommits: vi.fn(),
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
  logClientError: vi.fn(async () => {}),
  getLogFilePath: vi.fn(async () => "/tmp/openpatchline.log"),
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

describe("useAppStore slices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("opens repository and handles cancelled / notARepo outcomes", async () => {
    const store = createAppStore();

    mockedApi.openRepository.mockResolvedValueOnce({ kind: "cancelled" });
    await store.getState().openRepo();
    expect(store.getState().repo).toBeNull();

    mockedApi.openRepository.mockResolvedValueOnce({
      kind: "notARepo",
      path: "/tmp/ws",
      candidates: [{ name: "sub", path: "/tmp/ws/sub" }],
    });
    await store.getState().openRepo("/tmp/ws");
    expect(store.getState().repoCandidates).toEqual({
      path: "/tmp/ws",
      candidates: [{ name: "sub", path: "/tmp/ws/sub" }],
    });

    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");
    expect(store.getState().repo).toEqual(baseRepo);
    expect(store.getState().repoCandidates).toBeNull();
    expect(mockedApi.getCommitGraph).toHaveBeenCalled();
    expect(mockedApi.getFileStatus).toHaveBeenCalled();
    expect(mockedApi.listBranches).toHaveBeenCalled();
  });

  it("stages files, creates commits, and refreshes repo state", async () => {
    const store = createAppStore();
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");

    mockedApi.getFileStatus.mockResolvedValueOnce([
      { path: "a.ts", staged: "modified", unstaged: null, conflicted: false },
    ]);
    await store.getState().stageFile("a.ts");
    expect(mockedApi.stageFile).toHaveBeenCalledWith("/tmp/demo", "a.ts");
    expect(store.getState().fileStatus).toHaveLength(1);

    mockedApi.getRepoInfo.mockResolvedValueOnce({ ...baseRepo, headCommit: "2222222" });
    await store.getState().createCommit("feat: test");
    expect(mockedApi.createCommit).toHaveBeenCalledWith("/tmp/demo", "feat: test");
    expect(store.getState().repo?.headCommit).toBe("2222222");
  });

  it("handles cancelled fetch as notice instead of error", async () => {
    const store = createAppStore();
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");

    mockedApi.fetchRepository.mockRejectedValueOnce({ code: "cancelled", message: "操作已取消" });
    await store.getState().fetchRemote();

    expect(store.getState().error).toBeNull();
    expect(store.getState().notice).toBe("已取消获取远程");
    expect(store.getState().gitBusy).toBeNull();
    expect(store.getState().remoteProgress).toBeNull();
  });

  it("refreshes conflict state on pull conflict and supports abort/continue", async () => {
    const store = createAppStore();
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");

    mockedApi.pullRepository.mockRejectedValueOnce({
      code: "git",
      message: "git pull failed: CONFLICT",
    });
    mockedApi.getRepoInfo.mockResolvedValueOnce({ ...baseRepo, state: "merging" });
    mockedApi.getFileStatus.mockResolvedValueOnce([
      { path: "a.txt", staged: null, unstaged: null, conflicted: true },
    ]);

    await store.getState().pullRepo();
    expect(store.getState().repo?.state).toBe("merging");
    expect(store.getState().fileStatus[0].conflicted).toBe(true);
    expect(store.getState().error).toContain("冲突");

    mockedApi.abortOperation.mockResolvedValueOnce({ output: "", repo: baseRepo });
    mockedApi.getFileStatus.mockResolvedValueOnce([]);
    await store.getState().abortOperation();
    expect(store.getState().repo?.state).toBe("clean");
    expect(store.getState().notice).toBe("已中止当前操作并恢复工作区");
  });

  it("drops stale diff responses when switching files rapidly", async () => {
    const store = createAppStore();
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");

    let resolveFirst!: (val: FileDiffResult) => void;
    const firstPromise = new Promise<FileDiffResult>((r) => {
      resolveFirst = r;
    });
    const secondDiff: FileDiffResult = {
      oldPath: "b.ts",
      newPath: "b.ts",
      changeType: "modified",
      isBinary: false,
      tooLarge: false,
      rows: [],
      changeRowIndices: [],
      additions: 1,
      deletions: 0,
    };

    mockedApi.getFileDiff.mockReturnValueOnce(firstPromise).mockResolvedValueOnce(secondDiff);

    const files: ChangedFile[] = [
      { path: "a.ts", oldPath: null, changeType: "modified", additions: 1, deletions: 0 },
      { path: "b.ts", oldPath: null, changeType: "modified", additions: 1, deletions: 0 },
    ];

    const p1 = store.getState().openFileDiff({ kind: "workdir" }, files, 0);
    const p2 = store.getState().showDiffFile(1);
    await p2;

    resolveFirst({ ...secondDiff, oldPath: "a.ts", newPath: "a.ts" });
    await p1;

    expect(store.getState().selectedDiffFileIndex).toBe(1);
    expect(store.getState().currentFileDiff?.newPath).toBe("b.ts");
  });

  it("persists theme and updates log filter", () => {
    const store = createAppStore();
    store.getState().setTheme("light");
    expect(store.getState().theme).toBe("light");
    expect(window.localStorage.getItem("openpatchline:theme")).toBe("light");
  });

  it("supports range compare, swap direction, and commit history persistence", async () => {
    const store = createAppStore();
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");

    mockedApi.getRangeFiles.mockResolvedValueOnce([
      { path: "diff.ts", oldPath: null, changeType: "modified", additions: 2, deletions: 1 },
    ]);
    await store.getState().compareBranchWithCurrent("feat/ui");
    expect(mockedApi.getRangeFiles).toHaveBeenCalledWith("/tmp/demo", "main", "feat/ui");
    expect(store.getState().compareRange).toEqual({
      baseRef: "main",
      targetRef: "feat/ui",
      baseLabel: "main",
      targetLabel: "feat/ui",
    });
    expect(store.getState().rangeFiles).toHaveLength(1);

    mockedApi.getRangeFiles.mockResolvedValueOnce([]);
    await store.getState().swapCompareRange();
    expect(mockedApi.getRangeFiles).toHaveBeenLastCalledWith("/tmp/demo", "feat/ui", "main");

    await store.getState().createCommit("feat: history record");
    expect(store.getState().commitHistory[0]).toBe("feat: history record");
  });

  it("handles applyDiffSelection refresh and advances back to log when file cleared", async () => {
    const store = createAppStore();
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "opened", repo: baseRepo });
    await store.getState().openRepo("/tmp/demo");

    const file: ChangedFile = {
      path: "a.ts",
      oldPath: null,
      changeType: "modified",
      additions: 1,
      deletions: 0,
    };
    mockedApi.getFileDiff.mockResolvedValueOnce({
      oldPath: "a.ts",
      newPath: "a.ts",
      changeType: "modified",
      isBinary: false,
      tooLarge: false,
      rows: [],
      changeRowIndices: [],
      additions: 1,
      deletions: 0,
    });
    await store.getState().openFileDiff({ kind: "workdir" }, [file], 0);

    mockedApi.getFileStatus.mockResolvedValueOnce([
      { path: "a.ts", staged: "modified", unstaged: null, conflicted: false },
    ]);
    const ok = await store.getState().applyDiffSelection("stage", [{ rowIndex: 0, side: "new" }]);
    expect(ok).toBe(true);
    expect(mockedApi.applyDiffSelection).toHaveBeenCalledWith(
      "/tmp/demo",
      { kind: "workdir" },
      "a.ts",
      "stage",
      [{ rowIndex: 0, side: "new" }],
    );
    expect(store.getState().activeView).toBe("log");
  });
});
