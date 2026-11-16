/**
 * 提交详情面板（docs/06 §8.5）：选中提交的元信息 + 变更文件列表。
 * 点击 hash 复制完整 commit id；点击文件进入该提交的单文件 diff。
 */
import { useEffect, useMemo, useState } from "react";
import {
  BranchIcon,
  CheckIcon,
  CherryPickIcon,
  CloseIcon,
  CopyIcon,
  TagIcon,
  UndoIcon,
} from "../Icons";
import { useAppStore } from "../../store/app";
import type { ChangedFile, ChangeType } from "../../types";
import { formatAbsolute } from "./CommitTable";
import "./CommitDetail.css";

/** 变更类型 → 徽章字母（docs §2.2）。 */
const CHANGE_LETTER: Record<ChangeType, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  binary: "B",
  untracked: "??",
};

/** 复制文本：优先 Clipboard API，不可用时降级 execCommand。 */
function copyText(text: string): void {
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => {
      /* 剪贴板不可用时静默失败 */
    });
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* 忽略 */
  } finally {
    ta.remove();
  }
}

/** 拆出目录与文件名（目录部分在 UI 中做“截头”省略）。 */
function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

/** 根据作者姓名生成 1–2 位缩写与稳定色相。 */
function authorBadge(name: string): { initials: string; hue: number } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials =
    parts.length >= 2
      ? `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase()
      : (parts[0]?.slice(0, 2) ?? "?").toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return { initials, hue };
}

function CommitFileRow({ file, onClick }: { file: ChangedFile; onClick: () => void }) {
  const { dir, base } = splitPath(file.path);
  return (
    <button type="button" className={`cd-file cd-file--${file.changeType}`} onClick={onClick}>
      <span className={`cd-file-badge badge-${file.changeType}`}>
        {CHANGE_LETTER[file.changeType]}
      </span>
      <span className="cd-file-path" title={file.path}>
        {dir && <span className="cd-file-dir">{dir}</span>}
        <span className="cd-file-base">{base}</span>
      </span>
      <span className="cd-file-stats">
        {file.additions > 0 && <span className="cd-add">+{file.additions}</span>}
        {file.deletions > 0 && <span className="cd-del">−{file.deletions}</span>}
      </span>
    </button>
  );
}

export function CommitDetail() {
  const selectedCommitId = useAppStore((s) => s.selectedCommitId);
  const graphRows = useAppStore((s) => s.graphRows);
  const commitFiles = useAppStore((s) => s.commitFiles);
  const openFileDiff = useAppStore((s) => s.openFileDiff);
  const selectCommit = useAppStore((s) => s.selectCommit);
  const gitBusy = useAppStore((s) => s.gitBusy);
  const cherryPickCommit = useAppStore((s) => s.cherryPickCommit);
  const revertCommit = useAppStore((s) => s.revertCommit);
  const createBranch = useAppStore((s) => s.createBranch);
  const createTag = useAppStore((s) => s.createTag);
  const resetHead = useAppStore((s) => s.resetHead);

  const [copied, setCopied] = useState(false);
  const [inlineMode, setInlineMode] = useState<"branch" | "tag" | null>(null);
  const [inlineValue, setInlineValue] = useState("");

  const row = useMemo(
    () => graphRows.find((r) => r.commit.id === selectedCommitId) ?? null,
    [graphRows, selectedCommitId],
  );

  useEffect(() => {
    setCopied(false);
    setInlineMode(null);
    setInlineValue("");
  }, [selectedCommitId]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of commitFiles) {
      add += f.additions;
      del += f.deletions;
    }
    return { add, del };
  }, [commitFiles]);

  if (!row) {
    return (
      <aside className="commit-detail" aria-label="提交详情">
        <p className="cd-placeholder">未选中提交</p>
      </aside>
    );
  }

  const c = row.commit;
  const avatar = authorBadge(c.authorName);
  const nlIndex = c.message.indexOf("\n");
  const subject = nlIndex < 0 ? c.message : c.message.slice(0, nlIndex);
  const body = nlIndex < 0 ? "" : c.message.slice(nlIndex + 1).trim();

  const copyId = () => {
    copyText(c.id);
    setCopied(true);
  };

  const busy = gitBusy !== null;

  const toggleInline = (mode: "branch" | "tag") => {
    setInlineMode((prev) => (prev === mode ? null : mode));
    setInlineValue("");
  };

  const submitInline = async () => {
    const val = inlineValue.trim();
    if (!val || busy || !inlineMode) return;
    const ok =
      inlineMode === "branch" ? await createBranch(val, c.id, true) : await createTag(val, c.id);
    if (ok) {
      setInlineMode(null);
      setInlineValue("");
    }
  };

  return (
    <aside className="commit-detail" aria-label="提交详情">
      <div className="cd-topbar">
        <span className="cd-topbar-title">提交详情</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="关闭提交详情"
          title="关闭提交详情"
          onClick={() => void selectCommit(null)}
        >
          <CloseIcon />
        </button>
      </div>

      <button type="button" className="cd-hash" onClick={copyId} title="点击复制完整 Commit SHA">
        <div className="cd-hash-row">
          <span className="cd-short">{c.shortId}</span>
          <span className={`cd-copy-pill${copied ? " is-copied" : ""}`}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span>{copied ? "已复制" : "复制 SHA"}</span>
          </span>
        </div>
        <span className="cd-full">{c.id}</span>
      </button>

      <div className="cd-author-card">
        <span
          className="cd-avatar"
          style={{ background: `oklch(55% 0.14 ${avatar.hue})` }}
          aria-hidden="true"
        >
          {avatar.initials}
        </span>
        <div className="cd-author-info">
          <span className="cd-author-name">{c.authorName}</span>
          <span className="cd-author-meta">
            {c.authorEmail} · {formatAbsolute(c.timestamp)}
          </span>
        </div>
      </div>

      <div className="cd-message">
        <div className="cd-message-subject">{subject}</div>
        {body && <div className="cd-message-body">{body}</div>}
      </div>

      <div className="cd-actions" role="group" aria-label="提交操作">
        <button
          type="button"
          className="cd-action-btn"
          disabled={busy}
          title="将此提交应用到当前分支（git cherry-pick）"
          onClick={() => void cherryPickCommit(c.id)}
        >
          <CherryPickIcon />
          <span>挑选</span>
        </button>
        <button
          type="button"
          className="cd-action-btn"
          disabled={busy}
          title="生成反向提交以撤销此提交（git revert）"
          onClick={() => void revertCommit(c.id)}
        >
          <UndoIcon />
          <span>回滚</span>
        </button>
        <button
          type="button"
          className={`cd-action-btn${inlineMode === "branch" ? " is-active" : ""}`}
          disabled={busy}
          title="基于此提交创建并切换分支"
          onClick={() => toggleInline("branch")}
        >
          <BranchIcon />
          <span>建分支</span>
        </button>
        <button
          type="button"
          className={`cd-action-btn${inlineMode === "tag" ? " is-active" : ""}`}
          disabled={busy}
          title="在此提交创建标签（git tag）"
          onClick={() => toggleInline("tag")}
        >
          <TagIcon />
          <span>打标签</span>
        </button>
        <button
          type="button"
          className="cd-action-btn"
          disabled={busy}
          title="将当前分支软重置到此提交并保留修改在暂存区（git reset --soft）"
          onClick={() => void resetHead(c.id, "soft")}
        >
          <UndoIcon />
          <span>软重置</span>
        </button>
      </div>

      {inlineMode && (
        <div className="cd-inline-form">
          <input
            type="text"
            className="input cd-inline-input"
            autoFocus
            placeholder={inlineMode === "branch" ? "输入新分支名…" : "输入标签名（如 v1.0.0）…"}
            aria-label={inlineMode === "branch" ? "新分支名" : "新标签名"}
            value={inlineValue}
            disabled={busy}
            onChange={(e) => setInlineValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitInline();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setInlineMode(null);
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary cd-inline-btn"
            disabled={busy || !inlineValue.trim()}
            onClick={() => void submitInline()}
          >
            确定
          </button>
        </div>
      )}

      <div className="cd-files">
        <div className="cd-files-header">
          <span className="cd-files-title">变更文件 ({commitFiles.length})</span>
          {(totals.add > 0 || totals.del > 0) && (
            <span className="cd-files-totals">
              {totals.add > 0 && <span className="cd-add">+{totals.add}</span>}
              {totals.del > 0 && <span className="cd-del">−{totals.del}</span>}
            </span>
          )}
        </div>
        <div className="cd-files-list">
          {commitFiles.map((file, i) => (
            <CommitFileRow
              key={`${file.path}:${i}`}
              file={file}
              onClick={() => void openFileDiff({ kind: "commit", commitId: c.id }, commitFiles, i)}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
