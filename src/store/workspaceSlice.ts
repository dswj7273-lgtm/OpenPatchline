/**
 * 工作区状态、暂存区、提交、分支、远程同步、冲突处理与贮藏 Slice。
 */

import * as api from "../api/client";
import { recordCommitHistory } from "../utils/commitHelpers";
import {
  isCancelledError,
  lastOutputLine,
  reportError,
  type AppSlice,
  type GitBusy,
  type WorkspaceSlice,
} from "./types";

export const createWorkspaceSlice: AppSlice<WorkspaceSlice> = (set, get) => {
  /** 串行独占型 git 操作公共骨架：加锁 gitBusy、检查仓库切换过期、统一异常上报与状态复位。 */
  async function runExclusive(
    busyKind: Exclude<GitBusy, null>,
    source: string,
    opts: {
      isRemote?: boolean;
      cancelNotice?: string;
      onErrorRefresh?: () => Promise<void>;
    },
    task: (repoId: string) => Promise<boolean>,
  ): Promise<boolean> {
    const { repo, gitBusy } = get();
    if (!repo) {
      set({ error: "当前未打开仓库" });
      return false;
    }
    if (gitBusy !== null) return false;
    const repoId = repo.id;
    set({
      gitBusy: busyKind,
      error: null,
      notice: null,
      ...(opts.isRemote ? { remoteProgress: null } : {}),
    });
    try {
      return await task(repoId);
    } catch (e) {
      if (get().repo?.id !== repoId) return false;
      if (opts.isRemote && isCancelledError(e)) {
        set({ notice: opts.cancelNotice ?? "已取消远程操作" });
        return false;
      }
      const errMsg = reportError(source, e);
      if (opts.onErrorRefresh) await opts.onErrorRefresh();
      if (get().repo?.id === repoId) set({ error: errMsg });
      return false;
    } finally {
      set({
        gitBusy: null,
        ...(opts.isRemote ? { remoteProgress: null } : {}),
      });
    }
  }

  return {
    fileStatus: [],
    branches: [],
    branchesLoading: false,
    stashes: [],
    commitMetadata: null,
    commitHistory: [],
    gitBusy: null,
    remoteProgress: null,

    loadFileStatus: async () => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      try {
        const status = await api.getFileStatus(repo.id);
        set({ fileStatus: status });
      } catch (e) {
        set({ error: reportError("loadFileStatus", e) });
      }
    },

    loadCommitMetadata: async () => {
      const { repo } = get();
      if (!repo) return;
      const repoId = repo.id;
      try {
        const meta = await api.getCommitMetadata(repoId);
        if (get().repo?.id === repoId) set({ commitMetadata: meta });
      } catch {
        /* 模板/签名读取异常时静默退回默认配置 */
      }
    },

    stageFile: async (path) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      try {
        await api.stageFile(repo.id, path);
        await get().loadFileStatus();
      } catch (e) {
        set({ error: reportError("stageFile", e) });
      }
    },

    stageFiles: async (paths) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      if (paths.length === 0) return;
      set({ error: null });
      try {
        for (const path of paths) await api.stageFile(repo.id, path);
      } catch (e) {
        set({ error: reportError("stageFiles", e) });
      } finally {
        await get().loadFileStatus();
      }
    },

    unstageFile: async (path) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      try {
        await api.unstageFile(repo.id, path);
        await get().loadFileStatus();
      } catch (e) {
        set({ error: reportError("unstageFile", e) });
      }
    },

    unstageFiles: async (paths) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      if (paths.length === 0) return;
      set({ error: null });
      try {
        for (const path of paths) await api.unstageFile(repo.id, path);
      } catch (e) {
        set({ error: reportError("unstageFiles", e) });
      } finally {
        await get().loadFileStatus();
      }
    },

    createCommit: async (message, sign) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      const repoId = repo.id;
      try {
        if (sign === undefined) {
          await api.createCommit(repoId, message);
        } else {
          await api.createCommit(repoId, message, sign);
        }
        const history = recordCommitHistory(repoId, message);
        if (get().repo?.id === repoId) set({ commitHistory: history });
        await get().refreshRepoInfo();
        await get().loadFileStatus();
        await get().reloadGraph();
        await get().loadBranches();
      } catch (e) {
        set({ error: reportError("createCommit", e) });
      }
    },

    loadBranches: async () => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return;
      }
      set({ branchesLoading: true });
      try {
        const branches = await api.listBranches(repo.id);
        set({ branches });
      } catch (e) {
        set({ error: reportError("loadBranches", e) });
      } finally {
        set({ branchesLoading: false });
      }
    },

    checkoutBranch: async (name) => {
      await runExclusive("checkout", "checkoutBranch", {}, async (repoId) => {
        const info = await api.checkoutBranch(repoId, name);
        if (get().repo?.id !== repoId) return false;
        const filter = get().logFilter;
        if (filter.branch !== null) {
          set({ logFilter: { ...filter, branch: null } });
        }
        set({ repo: info, selectedCommitId: null, commitFiles: [] });
        await get().reloadGraph();
        await get().loadFileStatus();
        await get().loadBranches();
        if (get().error === null) {
          set({ notice: `已切换到 ${info.headBranch ?? name}` });
          return true;
        }
        return false;
      });
    },

    fetchRemote: async () => {
      await runExclusive(
        "fetch",
        "fetchRemote",
        { isRemote: true, cancelNotice: "已取消获取远程" },
        async (repoId) => {
          const result = await api.fetchRepository(repoId, null);
          if (get().repo?.id !== repoId) return false;
          await get().loadBranches();
          await get().reloadGraph();
          if (get().error === null) {
            const summary = lastOutputLine(result.output);
            set({ notice: `已获取 ${result.remote}${summary ? `：${summary}` : ""}` });
            return true;
          }
          return false;
        },
      );
    },

    pullRepo: async () => {
      await runExclusive(
        "pull",
        "pullRepo",
        {
          isRemote: true,
          cancelNotice: "已取消拉取",
          onErrorRefresh: async () => {
            await get().refreshRepoInfo();
            await get().loadFileStatus();
            await get().reloadGraph();
            await get().loadBranches();
          },
        },
        async (repoId) => {
          const result = await api.pullRepository(repoId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: result.repo, selectedCommitId: null, commitFiles: [] });
          await get().reloadGraph();
          await get().loadFileStatus();
          await get().loadBranches();
          if (get().error === null) {
            const summary = lastOutputLine(result.output);
            set({ notice: `拉取完成${summary ? `：${summary}` : ""}` });
            return true;
          }
          return false;
        },
      );
    },

    pushRepo: async () => {
      await runExclusive(
        "push",
        "pushRepo",
        { isRemote: true, cancelNotice: "已取消推送" },
        async (repoId) => {
          const result = await api.pushRepository(repoId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: result.repo });
          await get().loadBranches();
          await get().reloadGraph();
          if (get().error === null) {
            const summary = lastOutputLine(result.output);
            set({ notice: `推送完成${summary ? `：${summary}` : ""}` });
            return true;
          }
          return false;
        },
      );
    },

    loadStashes: async () => {
      const { repo } = get();
      if (!repo) return;
      try {
        const stashes = await api.listStashes(repo.id);
        if (get().repo?.id === repo.id) set({ stashes });
      } catch {
        /* 空仓库或暂不可用时静默忽略 */
      }
    },

    fetchAll: async () => {
      await runExclusive(
        "fetch",
        "fetchAll",
        { isRemote: true, cancelNotice: "已取消获取远程" },
        async (repoId) => {
          const res = await api.fetchAllRemotes(repoId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo });
          await get().loadBranches();
          await get().reloadGraph();
          if (get().error === null) {
            const summary = lastOutputLine(res.output);
            set({ notice: `已获取全部远程${summary ? `：${summary}` : ""}` });
            return true;
          }
          return false;
        },
      );
    },

    pullRebase: async () => {
      await runExclusive(
        "pull",
        "pullRebase",
        {
          isRemote: true,
          cancelNotice: "已取消变基拉取",
          onErrorRefresh: async () => {
            await get().refreshRepoInfo();
            await get().loadFileStatus();
            await get().reloadGraph();
            await get().loadBranches();
          },
        },
        async (repoId) => {
          const res = await api.pullRebaseRepository(repoId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo, selectedCommitId: null, commitFiles: [] });
          await get().reloadGraph();
          await get().loadFileStatus();
          await get().loadBranches();
          if (get().error === null) {
            const summary = lastOutputLine(res.output);
            set({ notice: `变基拉取完成${summary ? `：${summary}` : ""}` });
            return true;
          }
          return false;
        },
      );
    },

    pushForceWithLease: async () => {
      await runExclusive(
        "push",
        "pushForceWithLease",
        { isRemote: true, cancelNotice: "已取消推送" },
        async (repoId) => {
          const res = await api.pushForceWithLeaseRepository(repoId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo });
          await get().loadBranches();
          await get().reloadGraph();
          if (get().error === null) {
            const summary = lastOutputLine(res.output);
            set({ notice: `安全强推完成${summary ? `：${summary}` : ""}` });
            return true;
          }
          return false;
        },
      );
    },

    pushTags: async () => {
      await runExclusive(
        "push",
        "pushTags",
        { isRemote: true, cancelNotice: "已取消推送标签" },
        async (repoId) => {
          const res = await api.pushTagsRepository(repoId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo });
          await get().reloadGraph();
          if (get().error === null) {
            const summary = lastOutputLine(res.output);
            set({ notice: `标签推送完成${summary ? `：${summary}` : ""}` });
            return true;
          }
          return false;
        },
      );
    },

    cancelRemoteOp: async () => {
      const { repo } = get();
      if (!repo) return;
      try {
        await api.cancelRemoteOperation(repo.id);
      } catch (e) {
        set({ error: reportError("cancelRemoteOp", e) });
      }
    },

    setRemoteProgress: (ev) => {
      const { repo, gitBusy } = get();
      if (!repo || ev.repoId !== repo.id) return;
      if (gitBusy !== "fetch" && gitBusy !== "pull" && gitBusy !== "push") return;
      set({
        remoteProgress: {
          op: ev.op,
          message: ev.message,
          percent: ev.percent,
        },
      });
    },

    createBranch: async (name, startPoint = null, checkout = true) =>
      runExclusive("branch", "createBranch", {}, async (repoId) => {
        const res = await api.createBranch(repoId, name, startPoint ?? null, checkout);
        if (get().repo?.id !== repoId) return false;
        set({ repo: res.repo });
        await get().loadBranches();
        await get().reloadGraph();
        await get().loadFileStatus();
        if (get().error === null) {
          set({ notice: checkout ? `已创建并切换到分支 ${name}` : `已创建分支 ${name}` });
          return true;
        }
        return false;
      }),

    deleteBranch: async (name, force = false) => {
      await runExclusive("branch", "deleteBranch", {}, async (repoId) => {
        const res = await api.deleteBranch(repoId, name, force);
        if (get().repo?.id !== repoId) return false;
        set({ repo: res.repo });
        await get().loadBranches();
        await get().reloadGraph();
        if (get().error === null) {
          set({ notice: `已删除分支 ${name}` });
          return true;
        }
        return false;
      });
    },

    mergeBranch: async (name) => {
      await runExclusive(
        "merge",
        "mergeBranch",
        {
          onErrorRefresh: async () => {
            await get().refreshRepoInfo();
            await get().loadFileStatus();
            await get().reloadGraph();
            await get().loadBranches();
          },
        },
        async (repoId) => {
          const res = await api.mergeBranch(repoId, name);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo, selectedCommitId: null, commitFiles: [] });
          await get().reloadGraph();
          await get().loadFileStatus();
          await get().loadBranches();
          if (get().error === null) {
            const summary = lastOutputLine(res.output);
            set({ notice: `已合并 ${name}${summary ? `：${summary}` : ""}` });
            return true;
          }
          return false;
        },
      );
    },

    abortOperation: async () => {
      await runExclusive(
        "conflict",
        "abortOperation",
        {
          onErrorRefresh: async () => {
            await get().refreshRepoInfo();
            await get().loadFileStatus();
          },
        },
        async (repoId) => {
          const res = await api.abortOperation(repoId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo, selectedCommitId: null, commitFiles: [] });
          await get().loadFileStatus();
          await get().reloadGraph();
          await get().loadBranches();
          if (get().error === null) {
            set({ notice: "已中止当前操作并恢复工作区" });
            return true;
          }
          return false;
        },
      );
    },

    continueOperation: async () => {
      await runExclusive(
        "conflict",
        "continueOperation",
        {
          onErrorRefresh: async () => {
            await get().refreshRepoInfo();
            await get().loadFileStatus();
            await get().reloadGraph();
            await get().loadBranches();
          },
        },
        async (repoId) => {
          const res = await api.continueOperation(repoId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo, selectedCommitId: null, commitFiles: [] });
          await get().loadFileStatus();
          await get().reloadGraph();
          await get().loadBranches();
          if (get().error === null) {
            set({ notice: res.repo.state === "clean" ? "已完成操作" : "已推进到下一步" });
            return true;
          }
          return false;
        },
      );
    },

    createTag: async (name, target = null) =>
      runExclusive("tag", "createTag", {}, async (repoId) => {
        const res = await api.createTag(repoId, name, target ?? null);
        if (get().repo?.id !== repoId) return false;
        set({ repo: res.repo });
        await get().reloadGraph();
        if (get().error === null) {
          set({ notice: `已创建标签 ${name}` });
          return true;
        }
        return false;
      }),

    cherryPickCommit: async (commitId) => {
      await runExclusive(
        "cherryPick",
        "cherryPickCommit",
        {
          onErrorRefresh: async () => {
            await get().refreshRepoInfo();
            await get().loadFileStatus();
            await get().reloadGraph();
          },
        },
        async (repoId) => {
          const res = await api.cherryPickCommit(repoId, commitId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo });
          await get().reloadGraph();
          await get().loadFileStatus();
          await get().loadBranches();
          if (get().error === null) {
            set({ notice: `已挑选提交 ${commitId.slice(0, 7)} 到当前分支` });
            return true;
          }
          return false;
        },
      );
    },

    revertCommit: async (commitId) => {
      await runExclusive(
        "revert",
        "revertCommit",
        {
          onErrorRefresh: async () => {
            await get().refreshRepoInfo();
            await get().loadFileStatus();
            await get().reloadGraph();
          },
        },
        async (repoId) => {
          const res = await api.revertCommit(repoId, commitId);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo });
          await get().reloadGraph();
          await get().loadFileStatus();
          await get().loadBranches();
          if (get().error === null) {
            set({ notice: `已回滚提交 ${commitId.slice(0, 7)}` });
            return true;
          }
          return false;
        },
      );
    },

    resetHead: async (target, mode) => {
      await runExclusive("reset", "resetHead", {}, async (repoId) => {
        const res = await api.resetHead(repoId, target, mode);
        if (get().repo?.id !== repoId) return false;
        set({ repo: res.repo, selectedCommitId: null, commitFiles: [] });
        await get().reloadGraph();
        await get().loadFileStatus();
        await get().loadBranches();
        if (get().error === null) {
          set({
            notice: `已重置（--${mode}）到 ${target.length > 10 ? target.slice(0, 7) : target}`,
          });
          return true;
        }
        return false;
      });
    },

    discardFile: async (path) => {
      await runExclusive("discard", "discardFile", {}, async (repoId) => {
        await api.discardFile(repoId, path);
        if (get().repo?.id !== repoId) return false;
        await get().loadFileStatus();
        if (get().error === null) {
          set({ notice: `已丢弃更改：${path}` });
          return true;
        }
        return false;
      });
    },

    discardAllChanges: async () => {
      await runExclusive("discard", "discardAllChanges", {}, async (repoId) => {
        const res = await api.discardAll(repoId);
        if (get().repo?.id !== repoId) return false;
        set({ repo: res.repo });
        await get().loadFileStatus();
        await get().reloadGraph();
        await get().loadBranches();
        if (get().error === null) {
          set({ notice: "已丢弃工作区与暂存区全部未提交更改" });
          return true;
        }
        return false;
      });
    },

    amendCommit: async (message) =>
      runExclusive("amend", "amendCommit", {}, async (repoId) => {
        const res = await api.amendCommit(repoId, message);
        if (get().repo?.id !== repoId) return false;
        const history = recordCommitHistory(repoId, message);
        set({ repo: res.repo, commitHistory: history });
        await get().loadFileStatus();
        await get().reloadGraph();
        await get().loadBranches();
        if (get().error === null) {
          set({ notice: "已修正最近一次提交（Amend）" });
          return true;
        }
        return false;
      }),

    stashPush: async (message = null) =>
      runExclusive("stash", "stashPush", {}, async (repoId) => {
        const res = await api.stashPush(repoId, message ?? null);
        if (get().repo?.id !== repoId) return false;
        set({ repo: res.repo });
        await get().loadFileStatus();
        await get().loadStashes();
        if (get().error === null) {
          const summary = lastOutputLine(res.output);
          set({ notice: `贮藏完成${summary ? `：${summary}` : ""}` });
          return true;
        }
        return false;
      }),

    stashApply: async (index, pop) => {
      await runExclusive(
        "stash",
        "stashApply",
        {
          onErrorRefresh: async () => {
            await get().refreshRepoInfo();
            await get().loadFileStatus();
            await get().loadStashes();
          },
        },
        async (repoId) => {
          const res = await api.stashApply(repoId, index, pop);
          if (get().repo?.id !== repoId) return false;
          set({ repo: res.repo });
          await get().loadFileStatus();
          await get().loadStashes();
          if (get().error === null) {
            set({ notice: `${pop ? "已弹出" : "已应用"} stash@{${index}}` });
            return true;
          }
          return false;
        },
      );
    },

    stashDrop: async (index) => {
      await runExclusive("stash", "stashDrop", {}, async (repoId) => {
        const res = await api.stashDrop(repoId, index);
        if (get().repo?.id !== repoId) return false;
        set({ repo: res.repo });
        await get().loadStashes();
        if (get().error === null) {
          set({ notice: `已删除 stash@{${index}}` });
          return true;
        }
        return false;
      });
    },

    listRebaseCommits: async (limit = 20) => {
      const { repo } = get();
      if (!repo) {
        set({ error: "当前未打开仓库" });
        return [];
      }
      try {
        return await api.listRebaseCommits(repo.id, limit);
      } catch (e) {
        set({ error: reportError("listRebaseCommits", e) });
        return [];
      }
    },

    rewriteRecentCommits: async (plan) =>
      runExclusive("rebase", "rewriteRecentCommits", {}, async (repoId) => {
        const res = await api.rewriteRecentCommits(repoId, plan);
        if (get().repo?.id !== repoId) return false;
        set({
          repo: res.repo,
          selectedCommitId: null,
          commitFiles: [],
          commitSignature: null,
          compareRange: null,
          rangeFiles: [],
        });
        await get().reloadGraph();
        await get().loadBranches();
        if (get().error === null) {
          set({ notice: `已整理 ${plan.length} 条提交历史` });
          return true;
        }
        return false;
      }),
  };
};
