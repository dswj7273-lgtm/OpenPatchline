/**
 * 文件历史视图（v0.7 / 7.1）：单文件的提交历史列表（--follow 跨重命名）。
 *
 * - 行点击 → 以该提交为范围打开文件 Diff（Esc 返回本列表）；
 * - 行右键 → 查看差异 / Blame 该版本 / 复制 SHA；
 * - 重命名条目展示 `旧路径 → 新路径` 徽标。
 */

import { useEffect } from "react";
import { useContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { CloseIcon, HistoryIcon } from "../Icons";
import { useAppStore } from "../../store/app";
import type { ChangedFile, ChangeType, FileHistoryEntry } from "../../types";
import { copyText } from "../../utils/clipboard";
import "./FileHistoryView.css";

const CHANGE_LABEL: Record<ChangeType, string> = {
  modified: "改",
  added: "增",
  deleted: "删",
  renamed: "移",
  binary: "二",
  untracked: "未",
};

function formatRelative(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** 把历史条目转为 DiffView 可用的 ChangedFile。 */
function entryToFile(entry: FileHistoryEntry): ChangedFile {
  return {
    path: entry.path,
    oldPath: entry.oldPath,
    changeType: entry.changeType,
    additions: 0,
    deletions: 0,
  };
}

function HistoryRow({
  entry,
  onOpen,
  onContextMenu,
}: {
  entry: FileHistoryEntry;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const isRename = entry.changeType === "renamed" && entry.oldPath;
  return (
    <button
      type="button"
      className="fh-row"
      title={`${entry.summary}\n${entry.shortId} · ${entry.authorName}`}
      onClick={onOpen}
      onContextMenu={onContextMenu}
    >
      <span className={`fh-badge badge-${entry.changeType}`} aria-label={entry.changeType}>
        {CHANGE_LABEL[entry.changeType]}
      </span>
      <span className="fh-id">{entry.shortId}</span>
      <span className="fh-summary">{entry.summary}</span>
      <span className="fh-rename" title={`${entry.oldPath} → ${entry.path}`}>
        {isRename ? `${entry.oldPath} → ${entry.path}` : null}
      </span>
      <span className="fh-meta">
        <span className="fh-author">{entry.authorName}</span>
        <span className="fh-date">{formatRelative(entry.timestamp)}</span>
      </span>
    </button>
  );
}

export function FileHistoryView() {
  const path = useAppStore((s) => s.historyPath);
  const entries = useAppStore((s) => s.historyEntries);
  const loading = useAppStore((s) => s.historyLoading);
  const openFileDiff = useAppStore((s) => s.openFileDiff);
  const openFileBlame = useAppStore((s) => s.openFileBlame);
  const closeFileHistory = useAppStore((s) => s.closeFileHistory);
  const selectCommit = useAppStore((s) => s.selectCommit);
  const rowMenu = useContextMenu();

  useEffect(() => {
    if (!path && !loading) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFileHistory();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [path, loading, closeFileHistory]);

  const openEntry = (entry: FileHistoryEntry) => {
    void openFileDiff({ kind: "commit", commitId: entry.commitId }, [entryToFile(entry)], 0, {
      returnView: "history",
    });
  };

  const blameEntry = (entry: FileHistoryEntry) => {
    void openFileBlame(entry.path, entry.commitId, {
      returnView: "history",
    });
  };

  const menuFor = (entry: FileHistoryEntry): ContextMenuItem[] => [
    { key: "diff", label: "查看该提交的差异", onSelect: () => openEntry(entry) },
    { key: "blame", label: "Blame 该版本", onSelect: () => blameEntry(entry) },
    {
      key: "jump",
      label: "在提交列表中定位",
      onSelect: () => {
        closeFileHistory();
        void selectCommit(entry.commitId);
      },
    },
    {
      key: "copy",
      label: "复制完整 SHA",
      onSelect: () => {
        if (!copyText(entry.commitId)) {
          useAppStore.setState({ error: "复制失败：剪贴板不可用" });
        }
      },
    },
  ];

  return (
    <section className="fh-view" aria-label="文件历史">
      <header className="fh-header">
        <span className="fh-header__icon" aria-hidden="true">
          <HistoryIcon />
        </span>
        <span className="fh-header__path" title={path ?? ""}>
          {path ?? ""}
        </span>
        <span className="fh-header__count">{entries.length > 0 ? `${entries.length} 条` : ""}</span>
        {loading && <span className="fh-header__loading">加载中…</span>}
        <button
          type="button"
          className="icon-btn"
          aria-label="关闭文件历史"
          title="关闭文件历史 (Esc)"
          onClick={closeFileHistory}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="fh-list" role="list">
        {entries.length === 0 && !loading ? (
          <p className="fh-empty">该文件没有可追溯的提交历史</p>
        ) : (
          entries.map((entry) => (
            <HistoryRow
              key={entry.commitId}
              entry={entry}
              onOpen={() => openEntry(entry)}
              onContextMenu={(e) => rowMenu.open(e, menuFor(entry))}
            />
          ))
        )}
      </div>
      {rowMenu.render()}
    </section>
  );
}
