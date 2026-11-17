/**
 * 轻量交互式变基弹窗（4.5）：支持对最近 N 个连续非合并提交执行 Pick / Reword / Squash / Fixup。
 */
import { useEffect, useMemo, useState } from "react";
import { CloseIcon, RebaseIcon } from "../Icons";
import { useAppStore } from "../../store/app";
import type { RebaseAction, RebaseCommitEntry, RebasePlanEntry } from "../../types";

const ACTION_OPTIONS: { value: RebaseAction; label: string; hint: string }[] = [
  { value: "pick", label: "保留 (Pick)", hint: "原样保留该提交" },
  { value: "reword", label: "改写说明 (Reword)", hint: "保留代码变更，修改提交信息" },
  { value: "squash", label: "合并含文 (Squash)", hint: "合并到上一条保留提交并保留其说明" },
  { value: "fixup", label: "合并弃文 (Fixup)", hint: "合并到上一条保留提交并丢弃其说明" },
];

export function RebaseModal({ onClose }: { onClose: () => void }) {
  const repo = useAppStore((s) => s.repo);
  const fileStatus = useAppStore((s) => s.fileStatus);
  const gitBusy = useAppStore((s) => s.gitBusy);
  const listRebaseCommits = useAppStore((s) => s.listRebaseCommits);
  const rewriteRecentCommits = useAppStore((s) => s.rewriteRecentCommits);

  const [limit, setLimit] = useState(10);
  const [commits, setCommits] = useState<RebaseCommitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actions, setActions] = useState<Record<string, RebaseAction>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listRebaseCommits(limit).then((items) => {
      if (cancelled) return;
      setCommits(items);
      setActions((prev) => {
        const next: Record<string, RebaseAction> = {};
        items.forEach((c, idx) => {
          const prevAction = prev[c.id];
          next[c.id] =
            idx === 0 && (prevAction === "squash" || prevAction === "fixup")
              ? "pick"
              : (prevAction ?? "pick");
        });
        return next;
      });
      setMessages((prev) => {
        const next: Record<string, string> = {};
        items.forEach((c) => {
          next[c.id] = prev[c.id] ?? c.fullMessage;
        });
        return next;
      });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [limit, listRebaseCommits]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const hasDirtyTracked = useMemo(
    () =>
      fileStatus.some(
        (f) =>
          f.conflicted || f.staged !== null || (f.unstaged !== null && f.unstaged !== "untracked"),
      ),
    [fileStatus],
  );

  const summary = useMemo(() => {
    let kept = 0;
    let changed = false;
    let invalidReword = false;
    commits.forEach((c, idx) => {
      const act =
        idx === 0 && (actions[c.id] === "squash" || actions[c.id] === "fixup")
          ? "pick"
          : (actions[c.id] ?? "pick");
      if (act === "pick" || act === "reword") kept++;
      if (act !== "pick") changed = true;
      if (act === "reword" && !(messages[c.id] ?? "").trim()) invalidReword = true;
    });
    return { kept, changed, invalidReword };
  }, [commits, actions, messages]);

  const busy = gitBusy !== null || loading;
  const blockedByRepo = hasDirtyTracked || repo?.state !== "clean";
  const canApply =
    !busy && !blockedByRepo && commits.length > 0 && summary.changed && !summary.invalidReword;

  const submit = async () => {
    if (!canApply) return;
    const plan: RebasePlanEntry[] = commits.map((c, idx) => {
      const rawAct = actions[c.id] ?? "pick";
      const act = idx === 0 && (rawAct === "squash" || rawAct === "fixup") ? "pick" : rawAct;
      return {
        commitId: c.id,
        action: act,
        message: act === "reword" ? (messages[c.id] ?? "").trim() : null,
      };
    });
    const ok = await rewriteRecentCommits(plan);
    if (ok) onClose();
  };

  return (
    <div className="rebase-backdrop" role="presentation" onClick={onClose}>
      <section
        className="rebase-modal"
        role="dialog"
        aria-modal="true"
        aria-label="整理最近提交（轻量 Rebase）"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rebase-header">
          <div className="rebase-title-wrap">
            <RebaseIcon />
            <div>
              <h2 className="rebase-title">整理最近提交（Squash / Reword）</h2>
              <p className="rebase-sub">
                按时间从旧到新排列（最后一行是当前 HEAD）；合并后提交将折叠至上一条保留的提交
              </p>
            </div>
          </div>
          <div className="rebase-header-controls">
            <select
              className="input rebase-limit-select"
              aria-label="加载提交范围"
              value={limit}
              disabled={busy}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              <option value={5}>最近 5 条</option>
              <option value={10}>最近 10 条</option>
              <option value={20}>最近 20 条</option>
            </select>
            <button type="button" className="icon-btn" aria-label="关闭窗口" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </header>

        {blockedByRepo && (
          <div className="rebase-warning" role="alert">
            {repo?.state !== "clean"
              ? "仓库当前处于未完成操作状态，无法整理提交历史。"
              : "工作区或暂存区存在未提交修改，请先提交、暂存或贮藏后再执行整理。"}
          </div>
        )}

        <div className="rebase-list">
          {loading ? (
            <p className="rebase-empty">正在读取线性提交列表…</p>
          ) : commits.length === 0 ? (
            <p className="rebase-empty">暂无可整理的连续线性提交（可能遇到合并提交或空仓库）。</p>
          ) : (
            commits.map((c, idx) => {
              const act = actions[c.id] ?? "pick";
              const isSquashed = act === "squash" || act === "fixup";
              const isHead = idx === commits.length - 1;
              return (
                <div
                  key={c.id}
                  className={`rebase-item${isSquashed ? " is-squashed" : ""}${act === "reword" ? " is-reword" : ""}`}
                >
                  <div className="rebase-item-top">
                    <span className="rebase-sha">{c.shortId}</span>
                    {isHead && <span className="badge badge-head">HEAD</span>}
                    <span className="rebase-subject" title={c.subject}>
                      {c.subject || "(无标题)"}
                    </span>
                    <span className="rebase-author">{c.authorName}</span>
                    <select
                      className="input rebase-action-select"
                      aria-label={`操作 ${c.shortId}`}
                      value={act}
                      disabled={busy}
                      onChange={(e) =>
                        setActions((prev) => ({
                          ...prev,
                          [c.id]: e.target.value as RebaseAction,
                        }))
                      }
                    >
                      {ACTION_OPTIONS.map((opt) => (
                        <option
                          key={opt.value}
                          value={opt.value}
                          disabled={idx === 0 && (opt.value === "squash" || opt.value === "fixup")}
                          title={
                            idx === 0 && (opt.value === "squash" || opt.value === "fixup")
                              ? "最早一条提交无前置提交可合并，如需与更早提交合并请调大加载数量"
                              : opt.hint
                          }
                        >
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {act === "reword" && (
                    <textarea
                      className="input rebase-msg-input"
                      rows={3}
                      aria-label={`修改提交 ${c.shortId} 的提交说明`}
                      placeholder="输入新的提交信息…"
                      value={messages[c.id] ?? c.fullMessage}
                      disabled={busy}
                      onChange={(e) => setMessages((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>

        <footer className="rebase-footer">
          <span className="rebase-summary">
            {commits.length > 0 &&
              `当前 ${commits.length} 条 → 重写后 ${summary.kept} 条提交（改写本地历史，若已推送需使用安全强推）`}
          </span>
          <div className="rebase-footer-btns">
            <button type="button" className="btn" disabled={gitBusy !== null} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canApply}
              onClick={() => void submit()}
            >
              {gitBusy === "rebase" ? "整理中…" : "执行整理"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
