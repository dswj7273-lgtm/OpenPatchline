/**
 * Commit 面板纯辅助函数：提交信息历史持久化、常用模板与 Co-authored-by trailer 生成。
 */

const COMMIT_HISTORY_PREFIX = "openpatchline:commit-history:";
const MAX_HISTORY_ITEMS = 20;

export interface CommitSnippetTemplate {
  id: string;
  label: string;
  content: string;
}

export const CONVENTIONAL_TEMPLATES: CommitSnippetTemplate[] = [
  { id: "feat", label: "feat（新功能）", content: "feat: " },
  { id: "fix", label: "fix（修复缺陷）", content: "fix: " },
  { id: "refactor", label: "refactor（重构）", content: "refactor: " },
  { id: "docs", label: "docs（文档）", content: "docs: " },
  { id: "test", label: "test（测试）", content: "test: " },
  { id: "chore", label: "chore（工程杂项）", content: "chore: " },
];

/** 读取当前仓库最近使用过的提交说明列表（最新在前）。 */
export function loadCommitHistory(repoId: string): string[] {
  if (!repoId) return [];
  try {
    const raw = window.localStorage.getItem(`${COMMIT_HISTORY_PREFIX}${repoId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
}

/** 记录一条提交说明到仓库历史（去重、最新置顶、最多保留 20 条）。 */
export function recordCommitHistory(repoId: string, message: string): string[] {
  const trimmed = message.trim();
  if (!repoId || !trimmed) return loadCommitHistory(repoId);
  const existing = loadCommitHistory(repoId);
  const next = [trimmed, ...existing.filter((m) => m !== trimmed)].slice(0, MAX_HISTORY_ITEMS);
  try {
    window.localStorage.setItem(`${COMMIT_HISTORY_PREFIX}${repoId}`, JSON.stringify(next));
  } catch {
    /* 禁用存储时静默回退 */
  }
  return next;
}

const TRAILER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*:\s+.+$/;
const KNOWN_TRAILER_RE =
  /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|closes|fixes|refs):\s+/i;

/**
 * 向提交信息末尾追加标准 `Co-authored-by: Name <email>` trailer。
 * - 若已存在同邮箱或完全一致的 trailer 则幂等返回原内容；
 * - 若末尾段落已是一组 Git trailer（不误判单行 `feat: xxx` 标题），紧随其后追加；
 *   否则在正文与 trailer 之间保留一个空行。
 */
export function appendCoAuthorTrailer(message: string, name: string, email: string): string {
  const cleanName = name.trim();
  const cleanEmail = email.trim();
  if (!cleanName || !cleanEmail) return message;

  const trailer = `Co-authored-by: ${cleanName} <${cleanEmail}>`;
  const trimmedEnd = message.replace(/\s+$/, "");
  if (!trimmedEnd) return trailer;

  const lowerLines = trimmedEnd.split("\n").map((l) => l.trim().toLowerCase());
  if (
    lowerLines.includes(trailer.toLowerCase()) ||
    lowerLines.some(
      (l) => l.startsWith("co-authored-by:") && l.includes(`<${cleanEmail.toLowerCase()}>`),
    )
  ) {
    return trimmedEnd;
  }

  const paragraphs = trimmedEnd.split(/\r?\n[ \t]*\r?\n/);
  const lastParagraphLines = (paragraphs[paragraphs.length - 1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const endsWithTrailerBlock =
    lastParagraphLines.length > 0 &&
    ((paragraphs.length >= 2 && lastParagraphLines.every((l) => TRAILER_LINE_RE.test(l))) ||
      lastParagraphLines.every((l) => KNOWN_TRAILER_RE.test(l)));

  const sep = endsWithTrailerBlock ? "\n" : "\n\n";
  return `${trimmedEnd}${sep}${trailer}`;
}
