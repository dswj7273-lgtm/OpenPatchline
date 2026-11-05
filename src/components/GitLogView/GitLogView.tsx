/**
 * Git Log 视图（docs/06 §3）：筛选工具栏 + 提交表格 + 右侧提交详情。
 * 搜索 / 作者 / 分支过滤输入均在 300ms 防抖后写入 store 并重建提交图。
 */
import { useEffect, useRef, useState } from "react";
import { BranchIcon, CloseIcon, SearchIcon, UserIcon } from "../Icons";
import { useAppStore } from "../../store/app";
import { CommitDetail } from "./CommitDetail";
import { CommitTable } from "./CommitTable";
import "./GitLogView.css";

/** 输入防抖（ms）。 */
const FILTER_DEBOUNCE_MS = 300;
const SEARCH_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘ F" : "Ctrl F";

export function GitLogView() {
  const logFilter = useAppStore(s => s.logFilter);
  const setLogFilter = useAppStore(s => s.setLogFilter);
  const selectedCommitId = useAppStore(s => s.selectedCommitId);
  const graphLoading = useAppStore(s => s.graphLoading);

  const [search, setSearch] = useState("");
  const [author, setAuthor] = useState("");
  const [branch, setBranch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const authorInputRef = useRef<HTMLInputElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);

  // setLogFilter 会触发整图重建；用 ref 持有最新过滤器，
  // 避免把 logFilter 放进 effect 依赖导致“设置 → 变更 → 再设置”的循环。
  const filterRef = useRef(logFilter);
  filterRef.current = logFilter;

  useEffect(() => {
    const timer = setTimeout(() => {
      const query = search.trim() || null;
      const authorName = author.trim() || null;
      const branchName = branch.trim() || null;
      const cur = filterRef.current;
      if (cur.query === query && cur.author === authorName && cur.branch === branchName) return;
      setLogFilter({ ...cur, query, author: authorName, branch: branchName });
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, author, branch, setLogFilter]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <section className="gitlog" aria-label="提交历史">
      <div className="gitlog-toolbar">
        <div className="gitlog-filter-bar" role="search" aria-label="筛选提交历史">
          <div className="gitlog-search">
            <SearchIcon className="gitlog-search-icon" />
            <input
              ref={searchInputRef}
              type="search"
              className="gitlog-search-input"
              placeholder="搜索提交信息或哈希"
              aria-label="搜索提交"
              aria-keyshortcuts="Meta+F Control+F"
              autoComplete="off"
              spellCheck={false}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape" && search) {
                  e.stopPropagation();
                  setSearch("");
                }
              }}
            />
            {search ? (
              <button
                type="button"
                className="gitlog-clear"
                aria-label="清空提交搜索"
                title="清空搜索"
                onClick={() => {
                  setSearch("");
                  searchInputRef.current?.focus();
                }}
              >
                <CloseIcon />
              </button>
            ) : (
              <kbd className="gitlog-search-hint" aria-hidden="true">{SEARCH_SHORTCUT}</kbd>
            )}
          </div>

          <span className="gitlog-filter-divider" aria-hidden="true" />
          <div className={`gitlog-filter-field${author ? " has-value" : ""}`}>
            <UserIcon className="gitlog-filter-icon" />
            <input
              ref={authorInputRef}
              className="gitlog-filter-input"
              placeholder="作者"
              aria-label="按作者过滤"
              autoComplete="off"
              value={author}
              onChange={e => setAuthor(e.target.value)}
            />
            {author && (
              <button
                type="button"
                className="gitlog-clear"
                aria-label="清空作者过滤"
                title="清空作者"
                onClick={() => {
                  setAuthor("");
                  authorInputRef.current?.focus();
                }}
              >
                <CloseIcon />
              </button>
            )}
          </div>

          <span className="gitlog-filter-divider" aria-hidden="true" />
          <div className={`gitlog-filter-field${branch ? " has-value" : ""}`}>
            <BranchIcon className="gitlog-filter-icon" />
            <input
              ref={branchInputRef}
              className="gitlog-filter-input"
              placeholder="分支"
              aria-label="按分支过滤"
              autoComplete="off"
              value={branch}
              onChange={e => setBranch(e.target.value)}
            />
            {branch && (
              <button
                type="button"
                className="gitlog-clear"
                aria-label="清空分支过滤"
                title="清空分支"
                onClick={() => {
                  setBranch("");
                  branchInputRef.current?.focus();
                }}
              >
                <CloseIcon />
              </button>
            )}
          </div>
        </div>
        <span className={`gitlog-loading${graphLoading ? " is-visible" : ""}`} aria-live="polite">
          {graphLoading && (
            <>
              <span className="gitlog-loading-spinner" aria-hidden="true" />
              更新中
            </>
          )}
        </span>
      </div>
      <div className="gitlog-body">
        <CommitTable />
        {selectedCommitId !== null && <CommitDetail />}
      </div>
    </section>
  );
}
