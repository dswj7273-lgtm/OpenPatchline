/**
 * 交互式变基弹窗（v0.5 §4.5 → v0.7 / 7.3 扩展）：
 *
 * - Pick / Reword / Squash / Fixup / Drop 五种动作；
 * - 行拖拽排序（新顺序 = todo 执行顺序，自上而下逐条应用）；
 * - 执行前预览：模拟重写后的提交序列；
 * - 含重排或丢弃时后端委托 `git rebase -i`，可能产生冲突 →
 *   复用既有冲突编辑器与「继续 / 中止」链路；原历史始终备份于
 *   refs/opl-backup/rebase。
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
  { value: "drop", label: "丢弃 (Drop)", hint: "从历史中移除该提交（经 git rebase -i）" },
];

/** 预览中的单个结果条目。 */
interface PreviewItem {
  key: string;
  subject: string;
  mergedCount: number;
  dropped: boolean;
}

export function RebaseModal({ onClose }: { onClose: () => void }) {
  const repo = useAppStore((s) => s.repo);
  const fileStatus = useAppStore((s) => s.fileStatus);
  const gitBusy = useAppStore((s) => s.gitBusy);
  const listRebaseCommits = useAppStore((s) => s.listRebaseCommits);
  const interactiveRebase = useAppStore((s) => s.interactiveRebase);

  const [limit, setLimit] = useState(10);
  const [commits, setCommits] = useState<RebaseCommitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actions, setActions] = useState<Record<string, RebaseAction>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listRebaseCommits(limit).then((items) => {
      if (cancelled) return;
      setCommits(items);
      setActions((prev) => {
        const next: Record<string, RebaseAction> = {};
        items.forEach((c) => {
          next[c.id] = prev[c.id] ?? "pick";
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

  /** 当前顺序中第 0 条不可压缩（无前置可合并）。 */
  const effectiveAction = (id: string, isFirst: boolean): RebaseAction => {
    const raw = actions[id] ?? "pick";
    if (isFirst && (raw === "squash" || raw === "fixup")) return "pick";
    return raw;
  };

  /** 是否与原顺序（时间旧 → 新）不同：决定走 git rebase -i 还是轻量路径。 */
  const reordered = useMemo(
    () =>
      commits.length > 1 &&
      commits.some((c, idx) => idx > 0 && commits[idx - 1].timestamp > c.timestamp),
    [commits],
  );
  const hasDrop = useMemo(
    () => commits.some((c, idx) => effectiveAction(c.id, idx === 0) === "drop"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commits, actions],
  );
  const risky = reordered || hasDrop;

  /** 执行前预览：模拟重写后的提交序列。 */
  const preview = useMemo<PreviewItem[]>(() => {
    const items: PreviewItem[] = [];
    commits.forEach((c, idx) => {
      const act = effectiveAction(c.id, idx === 0);
      if (act === "drop") return;
      if (act === "squash" || act === "fixup") {
        const last = items[items.length - 1];
        if (last) {
          last.mergedCount += 1;
          if (act === "squash") {
            const extra = (messages[c.id] ?? c.fullMessage).trim();
            if (extra) last.subject = `${last.subject} ＋ ${extra.split("\n")[0]}`;
          }
          return;
        }
      }
      items.push({
        key: c.id,
        subject:
          act === "reword"
            ? (messages[c.id] ?? c.fullMessage).trim().split("\n")[0] || "(空说明)"
            : c.subject || "(无标题)",
        mergedCount: 0,
        dropped: false,
      });
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commits, actions, messages]);

  const summary = useMemo(() => {
    let invalidReword = false;
    commits.forEach((c, idx) => {
      const act = effectiveAction(c.id, idx === 0);
      if (act === "reword" && !(messages[c.id] ?? "").trim()) invalidReword = true;
    });
    const changed =
      commits.some((c, idx) => effectiveAction(c.id, idx === 0) !== "pick") || reordered;
    return { invalidReword, changed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commits, actions, messages, reordered]);

  const busy = gitBusy !== null || loading;
  const blockedByRepo = hasDirtyTracked || repo?.state !== "clean";
  const canApply =
    !busy && !blockedByRepo && commits.length > 0 && summary.changed && !summary.invalidReword;

  const submit = async () => {
    if (!canApply) return;
    const plan: RebasePlanEntry[] = commits.map((c, idx) => {
      const act = effectiveAction(c.id, idx === 0);
      return {
        commitId: c.id,
        action: act,
        message:
          act === "reword" || act === "squash" ? (messages[c.id] ?? "").trim() || null : null,
      };
    });
    const ok = await interactiveRebase(plan);
    if (ok) onClose();
  };

  /** 拖拽实时重排：进入新行时把拖动项移动到该位置。 */
  const onDragEnter = (idx: number) => {
    if (dragIndex === null || dragIndex === idx) return;
    setCommits((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(idx, 0, moved);
      return next;
    });
    setDragIndex(idx);
  };

  /** 键盘上移 / 下移（拖拽的无障碍替代）。 */
  const move = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= commits.length) return;
    setCommits((prev) => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  return (
    <div className="rebase-backdrop" role="presentation" onClick={onClose}>
      <section
        className="rebase-modal"
        role="dialog"
        aria-modal="true"
        aria-label="交互式整理最近提交"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rebase-header">
          <div className="rebase-title-wrap">
            <RebaseIcon />
            <div>
              <h2 className="rebase-title">交互式整理提交（Rebase）</h2>
              <p className="rebase-sub">
                自上而下为执行顺序：可拖拽排序、压缩或丢弃；含重排 / 丢弃时经 git rebase -i
                执行，冲突可在三方编辑器中解决后继续
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
        {risky && !blockedByRepo && (
          <div className="rebase-hint">
            检测到重排或丢弃：执行中可能出现冲突（原历史已备份于
            <code> refs/opl-backup/rebase</code>，可随时恢复）
          </div>
        )}

        <div className="rebase-list">
          {loading ? (
            <p className="rebase-empty">正在读取线性提交列表…</p>
          ) : commits.length === 0 ? (
            <p className="rebase-empty">暂无可整理的连续线性提交（可能遇到合并提交或空仓库）。</p>
          ) : (
            commits.map((c, idx) => {
              const act = effectiveAction(c.id, idx === 0);
              const isSquashed = act === "squash" || act === "fixup";
              return (
                <div
                  key={c.id}
                  className={`rebase-item${isSquashed ? " is-squashed" : ""}${act === "reword" ? " is-reword" : ""}${act === "drop" ? " is-dropped" : ""}${dragIndex === idx ? " is-dragging" : ""}`}
                  draggable={!busy}
                  onDragStart={() => setDragIndex(idx)}
                  onDragEnter={() => onDragEnter(idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnd={() => setDragIndex(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragIndex(null);
                  }}
                >
                  <div className="rebase-item-top">
                    <span className="rebase-drag" aria-hidden="true" title="拖拽排序">
                      ⠿
                    </span>
                    <span className="rebase-order">{idx + 1}</span>
                    <span className="rebase-sha">{c.shortId}</span>
                    <span className="rebase-subject" title={c.subject}>
                      {c.subject || "(无标题)"}
                    </span>
                    <span className="rebase-author">{c.authorName}</span>
                    <span className="rebase-move-btns">
                      <button
                        type="button"
                        className="rebase-move-btn"
                        aria-label="上移"
                        disabled={busy || idx === 0}
                        onClick={() => move(idx, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="rebase-move-btn"
                        aria-label="下移"
                        disabled={busy || idx === commits.length - 1}
                        onClick={() => move(idx, 1)}
                      >
                        ↓
                      </button>
                    </span>
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
                              ? "执行顺序中的第一条无前置提交可合并，如需与更早提交合并请先将其下移或调大加载数量"
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

        <div className="rebase-preview">
          <button
            type="button"
            className="rebase-preview-toggle"
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((v) => !v)}
          >
            {previewOpen ? "▾" : "▸"} 执行前预览（重写后 {preview.length} 条提交）
          </button>
          {previewOpen && (
            <ol className="rebase-preview-list">
              {preview.map((item, i) => (
                <li key={item.key} className="rebase-preview-item">
                  <span className="rebase-preview-order">{i + 1}</span>
                  <span className="rebase-preview-subject">{item.subject}</span>
                  {item.mergedCount > 0 && (
                    <span className="rebase-preview-merged">＋{item.mergedCount} 条合并</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        <footer className="rebase-footer">
          <span className="rebase-summary">
            {commits.length > 0 &&
              `当前 ${commits.length} 条 → 重写后 ${preview.length} 条（改写本地历史，若已推送需使用安全强推）`}
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
