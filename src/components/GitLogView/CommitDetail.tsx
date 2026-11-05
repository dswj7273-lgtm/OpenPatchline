/**
 * 提交详情面板（docs/06 §8.5）：选中提交的元信息 + 变更文件列表。
 * 点击 hash 复制完整 commit id；点击文件进入该提交的单文件 diff。
 */
import { useMemo } from "react";
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

function CommitFileRow({ file, onClick }: { file: ChangedFile; onClick: () => void }) {
  const { dir, base } = splitPath(file.path);
  return (
    <div
      className="cd-file"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <span className={`badge badge-${file.changeType}`}>{CHANGE_LETTER[file.changeType]}</span>
      <span className="cd-file-path" title={file.path}>
        {dir && <span className="cd-file-dir">{dir}</span>}
        <span className="cd-file-base">{base}</span>
      </span>
      {file.additions > 0 && <span className="cd-add">+{file.additions}</span>}
      {file.deletions > 0 && <span className="cd-del">-{file.deletions}</span>}
    </div>
  );
}

export function CommitDetail() {
  const selectedCommitId = useAppStore(s => s.selectedCommitId);
  const graphRows = useAppStore(s => s.graphRows);
  const commitFiles = useAppStore(s => s.commitFiles);
  const openFileDiff = useAppStore(s => s.openFileDiff);

  const row = useMemo(
    () => graphRows.find(r => r.commit.id === selectedCommitId) ?? null,
    [graphRows, selectedCommitId],
  );

  if (!row) {
    return (
      <aside className="commit-detail" aria-label="提交详情">
        <p className="cd-placeholder">未选中提交</p>
      </aside>
    );
  }

  const c = row.commit;
  const copyId = () => copyText(c.id);

  return (
    <aside className="commit-detail" aria-label="提交详情">
      <div className="cd-hash" onClick={copyId} title="点击复制完整 ID">
        <span className="cd-short">{c.shortId}</span>
        <span className="cd-full">{c.id}</span>
      </div>
      <dl className="cd-meta">
        <dt>作者</dt>
        <dd>
          {c.authorName} <span className="cd-email">{c.authorEmail}</span>
        </dd>
        <dt>时间</dt>
        <dd>{formatAbsolute(c.timestamp)}</dd>
      </dl>
      <div className="cd-message">{c.message}</div>
      <div className="cd-files">
        <div className="cd-files-title">变更文件（{commitFiles.length}）</div>
        {commitFiles.map((file, i) => (
          <CommitFileRow
            key={`${file.path}:${i}`}
            file={file}
            onClick={() => void openFileDiff({ kind: "commit", commitId: c.id }, commitFiles, i)}
          />
        ))}
      </div>
    </aside>
  );
}
