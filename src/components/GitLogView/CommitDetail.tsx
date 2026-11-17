/**
 * 提交详情与范围对比面板（docs/06 §8.5）：
 * - 单提交模式：元信息、GPG/SSH 签名状态、快捷操作、变更文件列表；
 * - 范围对比模式（4.3）：基线 → 目标方向互换、差异文件列表（点击进入 Range Diff）。
 */
import { useEffect, useMemo, useState } from "react";
import {
  BranchIcon,
  CheckIcon,
  CherryPickIcon,
  CloseIcon,
  CompareIcon,
  CopyIcon,
  HistoryIcon,
  RebaseIcon,
  ShieldCheckIcon,
  TagIcon,
  UndoIcon,
} from "../Icons";
import * as api from "../../api/client";
import { useAppStore } from "../../store/app";
import type { ChangedFile, ChangeType, CommitSignatureInfo, SignatureStatus } from "../../types";
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

const SIGNATURE_LABELS: Record<SignatureStatus, { label: string; tone: string }> = {
  verified: { label: "GPG/SSH 签名已验证", tone: "verified" },
  untrusted: { label: "已签名（密钥未受信任）", tone: "warn" },
  unverifiable: { label: "包含签名（本地无法验证）", tone: "muted" },
  bad: { label: "签名无效", tone: "danger" },
  expired: { label: "签名密钥已过期", tone: "danger" },
  revoked: { label: "签名密钥已吊销", tone: "danger" },
  unsigned: { label: "未签名", tone: "muted" },
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

function summarizeFiles(files: ChangedFile[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of files) {
    add += f.additions;
    del += f.deletions;
  }
  return { add, del };
}

function CommitFileRow({
  file,
  onClick,
  onBlame,
  onRestore,
}: {
  file: ChangedFile;
  onClick: () => void;
  onBlame?: () => void;
  /** 从该提交恢复此文件到工作区（v0.7 / 7.7）。 */
  onRestore?: () => void;
}) {
  const { dir, base } = splitPath(file.path);
  const canBlame =
    file.changeType !== "deleted" && file.changeType !== "binary" && Boolean(onBlame);
  return (
    <div className="cd-file-row">
      <button type="button" className={`cd-file cd-file--${file.changeType}`} onClick={onClick}>
        <span className={`cd-file-badge badge-${file.changeType}`}>
          {CHANGE_LETTER[file.changeType]}
        </span>
        <span
          className="cd-file-path"
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        >
          {dir && <span className="cd-file-dir">{dir}</span>}
          <span className="cd-file-base">{base}</span>
        </span>
        <span className="cd-file-stats">
          {file.additions > 0 && <span className="cd-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="cd-del">−{file.deletions}</span>}
        </span>
      </button>
      {canBlame && onBlame && (
        <button
          type="button"
          className="icon-btn cd-file-blame"
          aria-label={`查看 ${file.path} 的 Blame`}
          title="查看逐行 Blame"
          onClick={onBlame}
        >
          <HistoryIcon />
        </button>
      )}
      {onRestore && (
        <button
          type="button"
          className="icon-btn cd-file-restore"
          aria-label={`从该提交恢复 ${file.path}`}
          title="从该提交恢复此文件（覆盖工作区并暂存；有未提交修改时会拒绝）"
          onClick={onRestore}
        >
          <UndoIcon />
        </button>
      )}
    </div>
  );
}

function DiffFileListSection({
  title,
  files,
  onOpenFile,
  onBlameFile,
  onRestoreFile,
}: {
  title: string;
  files: ChangedFile[];
  onOpenFile: (index: number) => void;
  onBlameFile?: (file: ChangedFile) => void;
  onRestoreFile?: (file: ChangedFile) => void;
}) {
  const totals = useMemo(() => summarizeFiles(files), [files]);
  return (
    <div className="cd-files">
      <div className="cd-files-header">
        <span className="cd-files-title">
          {title} ({files.length})
        </span>
        {(totals.add > 0 || totals.del > 0) && (
          <span className="cd-files-totals">
            {totals.add > 0 && <span className="cd-add">+{totals.add}</span>}
            {totals.del > 0 && <span className="cd-del">−{totals.del}</span>}
          </span>
        )}
      </div>
      <div className="cd-files-list">
        {files.length === 0 ? (
          <p className="cd-placeholder">没有检测到文件差异</p>
        ) : (
          files.map((file, i) => (
            <CommitFileRow
              key={`${file.path}:${i}`}
              file={file}
              onClick={() => onOpenFile(i)}
              onBlame={onBlameFile ? () => onBlameFile(file) : undefined}
              onRestore={onRestoreFile ? () => onRestoreFile(file) : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SignatureBadge({ info }: { info: CommitSignatureInfo | null }) {
  if (!info) return null;
  const meta = SIGNATURE_LABELS[info.status];
  const detailParts = [meta.label];
  if (info.signer) detailParts.push(`签署人：${info.signer}`);
  if (info.keyId) detailParts.push(`密钥：${info.keyId}`);
  return (
    <div className={`cd-sig cd-sig--${meta.tone}`} title={detailParts.join("\n")}>
      <ShieldCheckIcon />
      <span className="cd-sig-label">{meta.label}</span>
      {info.signer && <span className="cd-sig-signer">{info.signer}</span>}
    </div>
  );
}

export function CommitDetail({ onOpenRebase }: { onOpenRebase?: () => void }) {
  const selectedCommitId = useAppStore((s) => s.selectedCommitId);
  const repo = useAppStore((s) => s.repo);
  const graphRows = useAppStore((s) => s.graphRows);
  const commitFiles = useAppStore((s) => s.commitFiles);
  const commitSignature = useAppStore((s) => s.commitSignature);
  const compareRange = useAppStore((s) => s.compareRange);
  const rangeFiles = useAppStore((s) => s.rangeFiles);
  const openFileDiff = useAppStore((s) => s.openFileDiff);
  const openFileBlame = useAppStore((s) => s.openFileBlame);
  const selectCommit = useAppStore((s) => s.selectCommit);
  const swapCompareRange = useAppStore((s) => s.swapCompareRange);
  const clearCompareRange = useAppStore((s) => s.clearCompareRange);
  const gitBusy = useAppStore((s) => s.gitBusy);
  const cherryPickCommit = useAppStore((s) => s.cherryPickCommit);
  const revertCommit = useAppStore((s) => s.revertCommit);
  const createBranch = useAppStore((s) => s.createBranch);
  const createTag = useAppStore((s) => s.createTag);
  const resetHead = useAppStore((s) => s.resetHead);
  const restoreFileFromCommit = useAppStore((s) => s.restoreFileFromCommit);

  const [copied, setCopied] = useState(false);
  const [inlineMode, setInlineMode] = useState<"branch" | "tag" | null>(null);
  const [inlineValue, setInlineValue] = useState("");
  const [containingBranches, setContainingBranches] = useState<string[]>([]);

  const row = useMemo(
    () => graphRows.find((r) => r.commit.id === selectedCommitId) ?? null,
    [graphRows, selectedCommitId],
  );

  // 所在分支（git branch --contains 语义，v0.7 / 7.5）。
  useEffect(() => {
    let cancelled = false;
    setContainingBranches([]);
    const repoId = useAppStore.getState().repo?.id;
    if (!repoId || !selectedCommitId) return;
    void api
      .listBranchesContaining(repoId, selectedCommitId)
      .then((names) => {
        if (!cancelled) setContainingBranches(names);
      })
      .catch(() => {
        /* 读取失败静默：分支徽标缺省不展示 */
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCommitId, repo?.id]);

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

  if (compareRange) {
    return (
      <aside className="commit-detail" aria-label="范围对比">
        <div className="cd-topbar">
          <span className="cd-topbar-title">范围对比</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭范围对比"
            title="关闭范围对比"
            onClick={clearCompareRange}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="cd-range-card">
          <div className="cd-range-endpoints">
            <div className="cd-range-point" title={compareRange.baseRef}>
              <span className="cd-range-kicker">基线 (旧)</span>
              <span className="cd-range-label">{compareRange.baseLabel}</span>
            </div>
            <span className="cd-range-arrow" aria-hidden="true">
              →
            </span>
            <div className="cd-range-point" title={compareRange.targetRef}>
              <span className="cd-range-kicker">目标 (新)</span>
              <span className="cd-range-label">{compareRange.targetLabel}</span>
            </div>
          </div>
          <button
            type="button"
            className="cd-action-btn cd-range-swap"
            title="互换基线与目标对比方向"
            onClick={() => void swapCompareRange()}
          >
            <CompareIcon />
            <span>互换对比方向</span>
          </button>
        </div>

        <DiffFileListSection
          title="差异文件"
          files={rangeFiles}
          onOpenFile={(i) =>
            void openFileDiff(
              {
                kind: "range",
                baseRef: compareRange.baseRef,
                targetRef: compareRange.targetRef,
              },
              rangeFiles,
              i,
            )
          }
          onBlameFile={(file) =>
            void openFileBlame(file.path, compareRange.targetRef, { returnView: "log" })
          }
        />
      </aside>
    );
  }

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

      <SignatureBadge info={commitSignature} />

      <div className="cd-message">
        <div className="cd-message-subject">{subject}</div>
        {body && <div className="cd-message-body">{body}</div>}
      </div>

      {(c.parentIds.length > 0 || containingBranches.length > 0) && (
        <div className="cd-relations">
          {c.parentIds.length > 0 && (
            <div className="cd-relations-row">
              <span className="cd-relations-label">父提交</span>
              <span className="cd-relations-items">
                {c.parentIds.map((pid) => (
                  <button
                    key={pid}
                    type="button"
                    className="cd-parent-chip"
                    title={`跳转到 ${pid.slice(0, 7)}`}
                    onClick={() => void selectCommit(pid)}
                  >
                    {pid.slice(0, 7)}
                  </button>
                ))}
              </span>
            </div>
          )}
          {containingBranches.length > 0 && (
            <div className="cd-relations-row">
              <span className="cd-relations-label">所在分支</span>
              <span className="cd-relations-items">
                {containingBranches.slice(0, 12).map((name) => (
                  <span key={name} className="cd-branch-chip" title={name}>
                    {name}
                  </span>
                ))}
                {containingBranches.length > 12 && (
                  <span className="cd-branch-chip cd-branch-chip--more">
                    +{containingBranches.length - 12}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}

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
        {onOpenRebase && (
          <button
            type="button"
            className="cd-action-btn"
            disabled={busy}
            title="打开轻量变基面板整理最近 N 个提交（Squash / Reword）"
            onClick={onOpenRebase}
          >
            <RebaseIcon />
            <span>整理历史</span>
          </button>
        )}
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

      <DiffFileListSection
        title="变更文件"
        files={commitFiles}
        onOpenFile={(i) => void openFileDiff({ kind: "commit", commitId: c.id }, commitFiles, i)}
        onBlameFile={(file) => void openFileBlame(file.path, c.id, { returnView: "log" })}
        onRestoreFile={(file) => void restoreFileFromCommit(c.id, file.path)}
      />
    </aside>
  );
}
