/**
 * DiffHeader 内的紧凑文件下拉列表 — docs/06 §8.4 DiffFileList。
 *
 * 当前文件 "i/N" 徽标，点击展开完整文件清单（状态字母 + 路径 +
 * +/- 统计），选择后切换 diff 文件。
 */

import { useEffect, useRef, useState } from "react";
import type { ChangeType, ChangedFile } from "../../types";

export interface DiffFileListProps {
  files: ChangedFile[];
  currentIndex: number;
  onSelect: (index: number) => void;
}

/** 文件状态徽标字母（docs/06 §2.2：字母 + 颜色双通道）。 */
function changeBadge(type: ChangeType): string {
  switch (type) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "binary":
      return "B";
    case "untracked":
      return "??";
  }
}

export default function DiffFileList({ files, currentIndex, onSelect }: DiffFileListProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 打开时：点击组件外或按 Escape 关闭。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 阻止冒泡：打开下拉时 Escape 只关闭下拉，不触发 App 层
        // 的“关闭 diff 视图”（window 级监听在 document 之后触发）。
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="diff-file-list" ref={rootRef}>
      <button
        type="button"
        className="diff-file-list__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={files[currentIndex]?.path ?? ""}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="diff-file-list__counter">
          {currentIndex + 1} / {files.length}
        </span>
        <span className="diff-file-list__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="diff-file-list__menu" role="listbox" aria-label="变更文件列表">
          {files.map((f, i) => (
            <li key={`${i}:${f.path}`} role="option" aria-selected={i === currentIndex}>
              <button
                type="button"
                className={`diff-file-list__item${i === currentIndex ? " is-current" : ""}`}
                title={f.path}
                onClick={() => {
                  onSelect(i);
                  setOpen(false);
                }}
              >
                <span className={`diff-file-list__badge diff-file-list__badge--${f.changeType}`}>
                  {changeBadge(f.changeType)}
                </span>
                <span className="diff-file-list__path">{f.path}</span>
                <span className="diff-file-list__stats">
                  <span className="diff-header__stat-add">+{f.additions}</span>
                  <span className="diff-header__stat-remove">−{f.deletions}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
