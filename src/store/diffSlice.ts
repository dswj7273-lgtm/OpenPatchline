/**
 * Diff 视图导航、单文件 Diff 加载与 Hunk/行级局部应用 Slice。
 */

import * as api from "../api/client";
import type { DiffPatchAction } from "../types";
import { reportError, type AppSlice, type DiffSlice } from "./types";

const PATCH_ACTION_CLEARED_NOTICE: Record<DiffPatchAction, string> = {
  stage: "已暂存所选变更，当前文件工作区已无剩余修改",
  unstage: "已取消暂存所选变更，当前文件暂存区已清空",
  discard: "已丢弃所选变更，当前文件工作区已恢复",
};

const PATCH_ACTION_NOTICE: Record<DiffPatchAction, string> = {
  stage: "已暂存所选变更",
  unstage: "已取消暂存所选变更",
  discard: "已丢弃所选变更",
};

export const createDiffSlice: AppSlice<DiffSlice> = (set, get) => {
  let diffReqSeq = 0;
  let conflictReqSeq = 0;
  let blameReqSeq = 0;

  return {
    activeView: "log",
    diffReturnView: "log",
    diffScope: null,
    diffFiles: [],
    selectedDiffFileIndex: 0,
    currentFileDiff: null,
    diffLoading: false,
    diffIgnoreWhitespace: null,
    conflictPath: null,
    conflictDetail: null,
    conflictLoading: false,
    blameResult: null,
    blameLoading: false,
    blameHistory: [],
    blameReturnView: "log",

    openFileDiff: async (scope, files, index, opts) => {
      const file = files[index];
      if (!file) {
        set({ error: "无效的文件索引" });
        return;
      }
      set({
        activeView: "diff",
        // 从文件历史 / Blame 打开时记录返回目标，Esc 回到来源而非日志（v0.7）。
        diffReturnView: opts?.returnView ?? "log",
        diffScope: scope,
        diffFiles: files,
        selectedDiffFileIndex: index,
        error: null,
      });
      await get().showDiffFile(index);
    },

    /** 生效的忽略空白选项：视图覆盖优先，否则跟随设置默认值。 */
    effectiveIgnoreWs: () => get().diffIgnoreWhitespace ?? get().settings.ignoreWhitespaceDefault,

    showDiffFile: async (index) => {
      const { repo, diffScope, diffFiles } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      if (!diffScope) {
        set({ error: "未选择差异比较范围" });
        return;
      }
      const file = diffFiles[index];
      if (!file) {
        set({ error: "无效的文件索引" });
        return;
      }
      const repoId = repo.id;
      const scopeSnapshot = diffScope;
      const seq = ++diffReqSeq;
      set({ selectedDiffFileIndex: index, diffLoading: true, error: null });
      try {
        const diff = await api.getFileDiff(
          repoId,
          scopeSnapshot,
          file.path,
          get().diffIgnoreWhitespace ?? get().settings.ignoreWhitespaceDefault,
        );
        const latest = get();
        if (
          latest.repo?.id !== repoId ||
          seq !== diffReqSeq ||
          latest.diffScope !== scopeSnapshot ||
          latest.selectedDiffFileIndex !== index ||
          latest.diffFiles[index]?.path !== file.path
        ) {
          return;
        }
        set({ currentFileDiff: diff });
      } catch (e) {
        if (get().repo?.id === repoId && seq === diffReqSeq) {
          set({ error: reportError("showDiffFile", e) });
        }
      } finally {
        if (seq === diffReqSeq) {
          set({ diffLoading: false });
        }
      }
    },

    setDiffIgnoreWhitespace: async (v) => {
      if (get().diffIgnoreWhitespace === v) return;
      set({ diffIgnoreWhitespace: v });
      if (get().activeView === "diff") {
        await get().showDiffFile(get().selectedDiffFileIndex);
      }
    },

    nextDiffFile: async () => {
      const { diffFiles, selectedDiffFileIndex } = get();
      if (selectedDiffFileIndex + 1 >= diffFiles.length) return;
      await get().showDiffFile(selectedDiffFileIndex + 1);
    },

    prevDiffFile: async () => {
      const { selectedDiffFileIndex } = get();
      if (selectedDiffFileIndex <= 0) return;
      await get().showDiffFile(selectedDiffFileIndex - 1);
    },

    goBackToLog: () => {
      diffReqSeq++;
      conflictReqSeq++;
      // 返回目标：从历史 / Blame 打开 Diff 时回到来源视图并保留其状态。
      const state = get();
      const returnTo =
        state.diffReturnView === "history" && state.historyPath !== null
          ? "history"
          : state.diffReturnView === "blame" && state.blameResult !== null
            ? "blame"
            : "log";
      set({
        activeView: returnTo,
        diffReturnView: "log",
        diffScope: null,
        diffFiles: [],
        selectedDiffFileIndex: 0,
        currentFileDiff: null,
        diffLoading: false,
        ...(returnTo === "log"
          ? {
              conflictPath: null,
              conflictDetail: null,
              conflictLoading: false,
              blameResult: null,
              blameLoading: false,
              blameHistory: [],
              blameReturnView: "log",
            }
          : {}),
      });
      blameReqSeq++;
    },

    applyDiffSelection: async (action, selections) => {
      const { repo, diffScope, diffFiles, selectedDiffFileIndex, currentFileDiff, gitBusy } = get();
      const ignoreWs = get().diffIgnoreWhitespace ?? get().settings.ignoreWhitespaceDefault;
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return false;
      }
      if (!diffScope || (diffScope.kind !== "workdir" && diffScope.kind !== "staged")) {
        set({ error: "当前对比范围不支持局部暂存或丢弃" });
        return false;
      }
      const currentFile = diffFiles[selectedDiffFileIndex];
      if (!currentFile || gitBusy !== null || selections.length === 0) return false;

      const repoId = repo.id;
      set({ gitBusy: "patch", error: null, notice: null });
      try {
        await api.applyDiffSelection(
          repoId,
          diffScope,
          currentFile.path,
          action,
          selections,
          ignoreWs,
        );
        if (get().repo?.id !== repoId) return false;

        await get().loadFileStatus();
        const updatedStatus = get().fileStatus;
        const renamedNewPath = currentFileDiff?.newPath;
        const entry =
          updatedStatus.find((f) => f.path === currentFile.path) ??
          (renamedNewPath ? updatedStatus.find((f) => f.path === renamedNewPath) : undefined);

        const stillChanged =
          entry !== undefined &&
          !entry.conflicted &&
          (diffScope.kind === "staged" ? entry.staged !== null : entry.unstaged !== null);

        if (stillChanged && entry) {
          const nextFiles = diffFiles.map((f, idx) =>
            idx === selectedDiffFileIndex ? { ...f, path: entry.path } : f,
          );
          const refreshed = await api.getFileDiff(
            repoId,
            diffScope,
            entry.path,
            get().diffIgnoreWhitespace ?? get().settings.ignoreWhitespaceDefault,
          );
          if (get().repo?.id === repoId && get().diffScope === diffScope) {
            set({
              diffFiles: nextFiles,
              currentFileDiff: refreshed,
              notice: PATCH_ACTION_NOTICE[action],
            });
          }
          return true;
        }

        const remaining = diffFiles.filter((_, idx) => idx !== selectedDiffFileIndex);
        if (remaining.length > 0) {
          const nextIndex = Math.min(selectedDiffFileIndex, remaining.length - 1);
          set({
            diffFiles: remaining,
            selectedDiffFileIndex: nextIndex,
            notice: PATCH_ACTION_NOTICE[action],
          });
          await get().showDiffFile(nextIndex);
        } else {
          get().goBackToLog();
          set({ notice: PATCH_ACTION_CLEARED_NOTICE[action] });
        }
        return true;
      } catch (e) {
        if (get().repo?.id === repoId) {
          set({ error: reportError("applyDiffSelection", e) });
        }
        return false;
      } finally {
        set({ gitBusy: null });
      }
    },

    openConflictFile: async (path) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      const repoId = repo.id;
      const seq = ++conflictReqSeq;
      set({
        activeView: "conflict",
        conflictPath: path,
        conflictLoading: true,
        error: null,
      });
      try {
        const detail = await api.getConflictFile(repoId, path);
        if (get().repo?.id !== repoId || seq !== conflictReqSeq || get().conflictPath !== path) {
          return;
        }
        set({ conflictDetail: detail });
      } catch (e) {
        if (get().repo?.id === repoId && seq === conflictReqSeq) {
          set({ error: reportError("openConflictFile", e) });
        }
      } finally {
        if (seq === conflictReqSeq) {
          set({ conflictLoading: false });
        }
      }
    },

    resolveConflictFile: async (path, content, stage, deleteFile = false) => {
      const { repo, gitBusy } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return false;
      }
      if (gitBusy !== null) return false;
      const repoId = repo.id;
      set({ gitBusy: "resolve", error: null, notice: null });
      try {
        await api.resolveConflictFile(repoId, path, content, stage, deleteFile);
        if (get().repo?.id !== repoId) return false;

        await get().loadFileStatus();
        if (!stage) {
          const detail = await api.getConflictFile(repoId, path);
          if (get().repo?.id === repoId) {
            set({ conflictDetail: detail, notice: `已保存 ${path}（尚未标记解决）` });
          }
          return true;
        }

        const remainingConflicts = get().fileStatus.filter((f) => f.conflicted);
        if (remainingConflicts.length > 0) {
          set({ notice: `已解决并暂存 ${path}（还有 ${remainingConflicts.length} 个冲突文件）` });
          await get().openConflictFile(remainingConflicts[0].path);
        } else {
          get().goBackToLog();
          set({ notice: `已解决并暂存 ${path}，所有文件冲突已处理完毕` });
        }
        return true;
      } catch (e) {
        if (get().repo?.id === repoId) {
          set({ error: reportError("resolveConflictFile", e) });
        }
        return false;
      } finally {
        set({ gitBusy: null });
      }
    },

    openFileBlame: async (path, commitId = null, opts) => {
      const { repo, blameResult, blameHistory, activeView } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      const repoId = repo.id;
      const seq = ++blameReqSeq;
      const pushHistory = opts?.pushHistory ?? false;
      const nextHistory =
        pushHistory && blameResult
          ? [...blameHistory, { path: blameResult.path, commitId: blameResult.commitId }]
          : pushHistory
            ? blameHistory
            : [];
      const returnView =
        opts?.returnView ??
        (activeView === "blame"
          ? get().blameReturnView
          : activeView === "diff"
            ? "diff"
            : activeView === "history"
              ? "history"
              : "log");

      set({
        activeView: "blame",
        blameLoading: true,
        blameHistory: nextHistory,
        blameReturnView: returnView,
        error: null,
      });
      try {
        const result = await api.getFileBlame(repoId, path, commitId);
        if (get().repo?.id !== repoId || seq !== blameReqSeq) return;
        set({ blameResult: result });
      } catch (e) {
        if (get().repo?.id === repoId && seq === blameReqSeq) {
          set({ error: reportError("openFileBlame", e) });
          if (!get().blameResult) {
            set({ activeView: returnView });
          }
        }
      } finally {
        if (seq === blameReqSeq) {
          set({ blameLoading: false });
        }
      }
    },

    goBackBlame: async () => {
      const { blameHistory } = get();
      if (blameHistory.length === 0) {
        get().closeBlame();
        return;
      }
      const prev = blameHistory[blameHistory.length - 1];
      set({ blameHistory: blameHistory.slice(0, -1) });
      await get().openFileBlame(prev.path, prev.commitId, {
        pushHistory: false,
        returnView: get().blameReturnView,
      });
    },

    closeBlame: () => {
      blameReqSeq++;
      const st = get();
      const target =
        st.blameReturnView === "diff" && st.currentFileDiff
          ? "diff"
          : st.blameReturnView === "history" && st.historyPath
            ? "history"
            : "log";
      set({
        activeView: target,
        blameResult: null,
        blameLoading: false,
        blameHistory: [],
        blameReturnView: "log",
      });
    },
  };
};
