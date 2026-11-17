/**
 * 提交历史图、提交详情与双提交/分支范围对比 Slice。
 */

import * as api from "../api/client";
import {
  EMPTY_LOG_FILTER,
  GRAPH_PAGE_SIZE,
  reportError,
  type AppSlice,
  type LogSlice,
} from "./types";

export const createLogSlice: AppSlice<LogSlice> = (set, get) => {
  let graphReqSeq = 0;
  let detailReqSeq = 0;
  let compareReqSeq = 0;

  return {
    graphRows: [],
    nextCursor: null,
    hasMore: false,
    graphLoading: false,
    logFilter: EMPTY_LOG_FILTER,
    selectedCommitId: null,
    commitFiles: [],
    commitSignature: null,
    compareRange: null,
    rangeFiles: [],

    loadMoreCommits: async () => {
      const { repo, nextCursor, hasMore, logFilter, graphLoading } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      if (!hasMore || nextCursor === null || graphLoading) return;
      const repoId = repo.id;
      const cursorSnapshot = nextCursor;
      const filterSnapshot = logFilter;
      const seq = ++graphReqSeq;
      set({ graphLoading: true, error: null });
      try {
        const page = await api.getCommitGraph(
          repoId,
          cursorSnapshot,
          GRAPH_PAGE_SIZE,
          filterSnapshot,
        );
        const latest = get();
        if (
          latest.repo?.id !== repoId ||
          seq !== graphReqSeq ||
          latest.nextCursor !== cursorSnapshot
        ) {
          return;
        }
        set({
          graphRows: [...latest.graphRows, ...page.rows],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      } catch (e) {
        if (get().repo?.id === repoId && seq === graphReqSeq) {
          set({ error: reportError("loadMoreCommits", e) });
        }
      } finally {
        if (seq === graphReqSeq) {
          set({ graphLoading: false });
        }
      }
    },

    reloadGraph: async () => {
      const { repo, logFilter } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      const repoId = repo.id;
      const filterSnapshot = logFilter;
      const seq = ++graphReqSeq;
      set({ graphLoading: true, error: null });
      try {
        const page = await api.getCommitGraph(repoId, null, GRAPH_PAGE_SIZE, filterSnapshot);
        if (get().repo?.id !== repoId || seq !== graphReqSeq) return;
        set({ graphRows: page.rows, nextCursor: page.nextCursor, hasMore: page.hasMore });
      } catch (e) {
        if (get().repo?.id === repoId && seq === graphReqSeq) {
          set({ error: reportError("reloadGraph", e) });
        }
      } finally {
        if (seq === graphReqSeq) {
          set({ graphLoading: false });
        }
      }
    },

    selectCommit: async (id) => {
      const detailSeq = ++detailReqSeq;
      compareReqSeq++;
      if (id === null) {
        set({
          selectedCommitId: null,
          commitFiles: [],
          commitSignature: null,
          compareRange: null,
          rangeFiles: [],
        });
        return;
      }
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      const repoId = repo.id;
      set({
        selectedCommitId: id,
        commitSignature: null,
        compareRange: null,
        rangeFiles: [],
        error: null,
      });
      const sigPromise = api.getCommitSignature(repoId, id).catch(() => null);
      try {
        const files = await api.getCommitFiles(repoId, id);
        if (
          get().repo?.id !== repoId ||
          detailSeq !== detailReqSeq ||
          get().selectedCommitId !== id ||
          get().compareRange !== null
        ) {
          return;
        }
        set({ commitFiles: files });
      } catch (e) {
        if (get().repo?.id === repoId && detailSeq === detailReqSeq) {
          set({ error: reportError("selectCommit", e) });
        }
      }
      const sig = await sigPromise;
      if (
        get().repo?.id === repoId &&
        detailSeq === detailReqSeq &&
        get().selectedCommitId === id &&
        get().compareRange === null
      ) {
        set({ commitSignature: sig });
      }
    },

    toggleCommitForCompare: async (id) => {
      const { selectedCommitId, compareRange, graphRows } = get();
      if (compareRange) {
        if (id === compareRange.baseRef || id === compareRange.targetRef) {
          const remaining =
            id === compareRange.baseRef ? compareRange.targetRef : compareRange.baseRef;
          await get().selectCommit(remaining);
          return;
        }
        const short = graphRows.find((r) => r.commit.id === id)?.commit.shortId ?? id.slice(0, 7);
        await get().compareCommits(compareRange.baseRef, id, compareRange.baseLabel, short);
        return;
      }
      if (!selectedCommitId || selectedCommitId === id) {
        await get().selectCommit(selectedCommitId === id ? null : id);
        return;
      }
      const idxA = graphRows.findIndex((r) => r.commit.id === selectedCommitId);
      const idxB = graphRows.findIndex((r) => r.commit.id === id);
      const aOlder = idxA >= 0 && idxB >= 0 ? idxA > idxB : false;
      const baseCommitId = aOlder ? selectedCommitId : id;
      const targetCommitId = aOlder ? id : selectedCommitId;
      const baseLabel =
        graphRows.find((r) => r.commit.id === baseCommitId)?.commit.shortId ??
        baseCommitId.slice(0, 7);
      const targetLabel =
        graphRows.find((r) => r.commit.id === targetCommitId)?.commit.shortId ??
        targetCommitId.slice(0, 7);
      await get().compareCommits(baseCommitId, targetCommitId, baseLabel, targetLabel);
    },

    compareCommits: async (baseRef, targetRef, baseLabel, targetLabel) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      const repoId = repo.id;
      const seq = ++compareReqSeq;
      detailReqSeq++;
      const range = {
        baseRef,
        targetRef,
        baseLabel: baseLabel ?? (baseRef.length > 12 ? baseRef.slice(0, 7) : baseRef),
        targetLabel: targetLabel ?? (targetRef.length > 12 ? targetRef.slice(0, 7) : targetRef),
      };
      set({
        activeView: "log",
        selectedCommitId: null,
        commitFiles: [],
        commitSignature: null,
        compareRange: range,
        rangeFiles: [],
        error: null,
      });
      try {
        const files = await api.getRangeFiles(repoId, baseRef, targetRef);
        const current = get().compareRange;
        if (
          get().repo?.id === repoId &&
          seq === compareReqSeq &&
          current?.baseRef === baseRef &&
          current?.targetRef === targetRef
        ) {
          set({ rangeFiles: files });
        }
      } catch (e) {
        if (get().repo?.id === repoId && seq === compareReqSeq) {
          set({ error: reportError("compareCommits", e) });
        }
      }
    },

    compareBranchWithCurrent: async (branchName) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      if (!repo.headBranch && !repo.headCommit) {
        set({ error: "空仓库暂无基准提交可供对比" });
        return;
      }
      const baseRef = repo.headBranch ?? repo.headCommit;
      await get().compareCommits(baseRef, branchName, baseRef, branchName);
    },

    swapCompareRange: async () => {
      const { compareRange } = get();
      if (!compareRange) return;
      await get().compareCommits(
        compareRange.targetRef,
        compareRange.baseRef,
        compareRange.targetLabel,
        compareRange.baseLabel,
      );
    },

    clearCompareRange: () => {
      set({ compareRange: null, rangeFiles: [] });
    },

    setLogFilter: (f) => {
      set({ logFilter: f });
      void get().reloadGraph();
    },
  };
};
