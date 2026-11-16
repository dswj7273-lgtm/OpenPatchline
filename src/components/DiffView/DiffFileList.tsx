/**
 * DiffHeader 内的紧凑文件下拉列表 — docs/06 §8.4 DiffFileList。
 *
 * 当前文件 "i / N" 徽标，点击展开完整文件清单（状态字母 + 路径 +
 * +/- 统计），选择后切换 diff 文件。
 */

import { useEffect, useRef, useState } from "react";
import type { ChangeType, ChangedFile } from "../../types";
import { ChevronDownIcon } from "../Icons";

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
      return "U";
  }
}

function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

export default function DiffFileList({ files, currentIndex, onSelect }: DiffFileListProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
        className={`diff-file-list__trigger${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={files[currentIndex]?.path ?? ""}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="diff-file-list__counter">
          {currentIndex + 1} / {files.length}
        </span>
        <ChevronDownIcon className="diff-file-list__chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul className="diff-file-list__menu" role="listbox" aria-label="变更文件列表">
          {files.map((f, i) => {
            const { dir, base } = splitPath(f.path);
            return (
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
                  <span className="diff-file-list__path">
                    {dir && <span className="diff-file-list__dir">{dir}</span>}
                    <span className="diff-file-list__base">{base}</span>
                  </span>
                  {(f.additions > 0 || f.deletions > 0) && (
                    <span className="diff-file-list__stats">
                      {f.additions > 0 && (
                        <span className="diff-header__stat-add">+{f.additions}</span>
                      )}
                      {f.deletions > 0 && (
                        <span className="diff-header__stat-remove">−{f.deletions}</span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
