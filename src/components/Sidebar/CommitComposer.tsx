/**
 * 侧栏底部提交卡片（4.4 增强）：
 * 提交信息历史、仓库/常规提交模板、Co-authored-by 助手、GPG/SSH 签名状态与开关、Amend 支持。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/app";
import { appendCoAuthorTrailer, CONVENTIONAL_TEMPLATES } from "../../utils/commitHelpers";
import { CommitIcon, HistoryIcon, ShieldCheckIcon, TemplateIcon, UserIcon } from "../Icons";

const COMMIT_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘ ↵" : "Ctrl ↵";

type ComposerTool = "history" | "template" | "coauthor" | null;

export function CommitComposer() {
  const repo = useAppStore((s) => s.repo);
  const fileStatus = useAppStore((s) => s.fileStatus);
  const graphRows = useAppStore((s) => s.graphRows);
  const gitBusy = useAppStore((s) => s.gitBusy);
  const commitMetadata = useAppStore((s) => s.commitMetadata);
  const commitHistory = useAppStore((s) => s.commitHistory);
  const createCommit = useAppStore((s) => s.createCommit);
  const amendCommit = useAppStore((s) => s.amendCommit);

  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<ComposerTool>(null);
  const [signOverride, setSignOverride] = useState<boolean | null>(null);
  const [coName, setCoName] = useState("");
  const [coEmail, setCoEmail] = useState("");

  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSignOverride(null);
    setActiveTool(null);
  }, [repo?.id]);

  useEffect(() => {
    if (!activeTool) return;
    const onPointerDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setActiveTool(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveTool(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeTool]);

  const conflicted = useMemo(() => fileStatus.filter((f) => f.conflicted), [fileStatus]);
  const staged = useMemo(
    () => fileStatus.filter((f) => !f.conflicted && f.staged !== null),
    [fileStatus],
  );

  const coAuthorCandidates = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of graphRows) {
      const email = row.commit.authorEmail.trim();
      const name = row.commit.authorName.trim();
      if (name && email && !seen.has(email.toLowerCase())) {
        seen.set(email.toLowerCase(), `${name}\0${email}`);
      }
    }
    return [...seen.values()].slice(0, 12).map((packed) => {
      const [name, email] = packed.split("\0");
      return { name, email };
    });
  }, [graphRows]);

  const hasConflicts = conflicted.length > 0;
  const isRebasing = repo?.state === "rebasing";
  const canSubmit =
    !busy &&
    gitBusy === null &&
    !hasConflicts &&
    !isRebasing &&
    Boolean(message.trim()) &&
    (amend ? Boolean(repo?.headCommit) : staged.length > 0);

  const effectiveSign = signOverride ?? commitMetadata?.gpgSignEnabled ?? false;
  const gpgFormat = (commitMetadata?.gpgFormat ?? "openpgp").toUpperCase();

  const toggleAmend = (checked: boolean) => {
    setAmend(checked);
    if (checked && !message.trim()) {
      const headMsg =
        graphRows.find((r) => r.commit.id === repo?.headCommit)?.commit.message ??
        graphRows[0]?.commit.message ??
        "";
      if (headMsg) setMessage(headMsg);
    }
  };

  const applyTemplateText = (text: string) => {
    setMessage((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${text}` : text));
    setActiveTool(null);
  };

  const addCoAuthor = (name: string, email: string) => {
    if (!name.trim() || !email.trim()) return;
    setMessage((prev) => appendCoAuthorTrailer(prev, name, email));
    setCoName("");
    setCoEmail("");
  };

  const submitCommit = async () => {
    const msg = message.trim();
    if (!msg || !canSubmit) return;
    setBusy(true);
    try {
      if (amend) {
        const ok = await amendCommit(msg);
        if (ok) {
          setMessage("");
          setAmend(false);
        }
      } else {
        const signArg =
          signOverride !== null ? signOverride : commitMetadata?.gpgSignEnabled ? true : undefined;
        await createCommit(msg, signArg);
        if (useAppStore.getState().error === null) setMessage("");
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleTool = (tool: Exclude<ComposerTool, null>) => {
    setActiveTool((prev) => (prev === tool ? null : tool));
  };

  return (
    <div className="sidebar-commit" ref={cardRef}>
      <div className="sidebar-commit-card">
        {activeTool && (
          <div className="sidebar-commit-popover" role="dialog" aria-label="提交辅助工具">
            {activeTool === "history" && (
              <div className="sidebar-commit-pop-list">
                <div className="sidebar-commit-pop-title">最近提交信息</div>
                {commitHistory.length === 0 ? (
                  <p className="sidebar-commit-pop-empty">当前仓库暂无本地提交记录</p>
                ) : (
                  commitHistory.map((item, idx) => (
                    <button
                      key={`${idx}:${item.slice(0, 24)}`}
                      type="button"
                      className="sidebar-commit-pop-item"
                      title={item}
                      onClick={() => {
                        setMessage(item);
                        setActiveTool(null);
                      }}
                    >
                      <span className="sidebar-commit-pop-text">{item.split("\n")[0]}</span>
                    </button>
                  ))
                )}
              </div>
            )}

            {activeTool === "template" && (
              <div className="sidebar-commit-pop-list">
                <div className="sidebar-commit-pop-title">提交模板与快捷前缀</div>
                {commitMetadata?.commitTemplate && (
                  <button
                    type="button"
                    className="sidebar-commit-pop-item is-repo-tpl"
                    title={commitMetadata.commitTemplate}
                    onClick={() => {
                      setMessage(commitMetadata.commitTemplate ?? "");
                      setActiveTool(null);
                    }}
                  >
                    <span className="sidebar-commit-pop-badge">commit.template</span>
                    <span className="sidebar-commit-pop-text">
                      {commitMetadata.commitTemplate.split("\n")[0] || "应用仓库默认模板"}
                    </span>
                  </button>
                )}
                {CONVENTIONAL_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="sidebar-commit-pop-item"
                    onClick={() => applyTemplateText(tpl.content)}
                  >
                    <span className="sidebar-commit-pop-badge">{tpl.id}</span>
                    <span className="sidebar-commit-pop-text">{tpl.label}</span>
                  </button>
                ))}
              </div>
            )}

            {activeTool === "coauthor" && (
              <div className="sidebar-commit-pop-list">
                <div className="sidebar-commit-pop-title">添加 Co-authored-by</div>
                <div className="sidebar-coauthor-form">
                  <input
                    type="text"
                    className="input sidebar-coauthor-input"
                    placeholder="姓名"
                    aria-label="共同作者姓名"
                    value={coName}
                    onChange={(e) => setCoName(e.target.value)}
                  />
                  <input
                    type="email"
                    className="input sidebar-coauthor-input"
                    placeholder="邮箱"
                    aria-label="共同作者邮箱"
                    value={coEmail}
                    onChange={(e) => setCoEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCoAuthor(coName, coEmail);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn sidebar-coauthor-add"
                    disabled={!coName.trim() || !coEmail.trim()}
                    onClick={() => addCoAuthor(coName, coEmail)}
                  >
                    加入
                  </button>
                </div>
                {coAuthorCandidates.map((c) => (
                  <button
                    key={c.email}
                    type="button"
                    className="sidebar-commit-pop-item"
                    title={`Co-authored-by: ${c.name} <${c.email}>`}
                    onClick={() => addCoAuthor(c.name, c.email)}
                  >
                    <span className="sidebar-commit-pop-text">{c.name}</span>
                    <span className="sidebar-commit-pop-meta">{c.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="sidebar-commit-tools" role="toolbar" aria-label="提交辅助">
          <button
            type="button"
            className={`sidebar-commit-tool${activeTool === "history" ? " is-active" : ""}`}
            aria-expanded={activeTool === "history"}
            title="从历史提交信息恢复"
            onClick={() => toggleTool("history")}
          >
            <HistoryIcon />
            <span>历史</span>
          </button>
          <button
            type="button"
            className={`sidebar-commit-tool${activeTool === "template" ? " is-active" : ""}`}
            aria-expanded={activeTool === "template"}
            title="填入 commit.template 或快捷格式模板"
            onClick={() => toggleTool("template")}
          >
            <TemplateIcon />
            <span>模板</span>
          </button>
          <button
            type="button"
            className={`sidebar-commit-tool${activeTool === "coauthor" ? " is-active" : ""}`}
            aria-expanded={activeTool === "coauthor"}
            title="插入 Co-authored-by 共同作者署名"
            onClick={() => toggleTool("coauthor")}
          >
            <UserIcon />
            <span>Co-author</span>
          </button>
        </div>

        <textarea
          className="sidebar-commit-input"
          placeholder="输入提交说明…"
          aria-label="提交信息"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submitCommit();
            }
          }}
        />

        <div className="sidebar-commit-options">
          <label className="sidebar-commit-amend">
            <input
              type="checkbox"
              checked={amend}
              disabled={busy || hasConflicts || isRebasing || !repo?.headCommit}
              onChange={(e) => toggleAmend(e.target.checked)}
            />
            <span>Amend</span>
          </label>

          {!amend && (
            <label
              className={`sidebar-commit-sign${effectiveSign ? " is-enabled" : ""}`}
              title={
                commitMetadata?.signingKey
                  ? `格式 ${gpgFormat} · 密钥 ${commitMetadata.signingKey}`
                  : commitMetadata?.gpgSignEnabled
                    ? `仓库已启用 ${gpgFormat} 自动签名`
                    : "勾选以使用 git -S 签名提交（需已配置签名密钥）"
              }
            >
              <input
                type="checkbox"
                checked={effectiveSign}
                disabled={busy || hasConflicts || isRebasing}
                onChange={(e) => setSignOverride(e.target.checked)}
              />
              <ShieldCheckIcon />
              <span>{effectiveSign ? `${gpgFormat} 签名` : "签名 (-S)"}</span>
            </label>
          )}
        </div>

        {(hasConflicts || isRebasing) && (
          <p className="sidebar-commit-hint" role="status">
            {hasConflicts
              ? `存在 ${conflicted.length} 个冲突文件，解决并标记后方可继续`
              : "变基中，请在顶部横幅点击「继续」完成变基"}
          </p>
        )}

        <div className="sidebar-commit-actions">
          <span className="sidebar-commit-meta">
            <span className={`sidebar-commit-staged${staged.length > 0 ? " has-staged" : ""}`}>
              {staged.length} 已暂存
            </span>
            <kbd title="Cmd/Ctrl + Enter">{COMMIT_SHORTCUT}</kbd>
          </span>
          <button
            type="button"
            className="btn btn-primary sidebar-commit-btn"
            disabled={!canSubmit}
            onClick={() => void submitCommit()}
          >
            <CommitIcon />
            {busy ? "提交中…" : amend ? "修正提交" : "提交"}
          </button>
        </div>
      </div>
    </div>
  );
}
