/**
 * 统一错误规整与本地错误日志上报（Task 3.6）。
 *
 * - 将 Rust `AppError` 载荷、原生 Error 或字符串规整为一致的用户可读提示；
 * - 对常见底层 git / 网络 / 凭证错误翻译或补充中文指引，同时保留关键上下文；
 * - 异步静默上报原始错误信息到本地日志文件（Tauri 环境外安全跳过）。
 */

import * as api from "../api/client";

/** 提取原始错误详情字符串（供日志记录与对比）。 */
export function rawErrorDetail(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as { code?: unknown; message?: unknown };
    const msg = obj.message !== undefined ? String(obj.message) : String(e);
    return obj.code ? `[${String(obj.code)}] ${msg}` : msg;
  }
  return String(e);
}

/** 判断是否为后端主动取消错误（AppError::Cancelled）。 */
export function isCancelledError(e: unknown): boolean {
  return Boolean(
    e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "cancelled",
  );
}

/** 剥离 Rust `thiserror` 英文前缀并翻译高频 git 底层错误，统一 Toast/提示条文案。 */
export function formatErrorMessage(e: unknown): string {
  if (isCancelledError(e)) return "操作已取消";

  let msg =
    e && typeof e === "object" && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);

  msg = msg
    .replace(/^git error:\s*/i, "")
    .replace(/^io error:\s*/i, "")
    .replace(/^invalid argument:\s*/i, "")
    .replace(/^not found:\s*/i, "")
    .replace(/^unexpected error:\s*/i, "")
    .trim();

  if (!msg) return "发生未知错误";

  const lower = msg.toLowerCase();
  if (lower.includes("authentication failed") || lower.includes("could not read username")) {
    return `远程认证失败，请检查系统凭证或 SSH 密钥配置\n${msg}`;
  }
  if (
    lower.includes("could not resolve host") ||
    lower.includes("failed to connect") ||
    lower.includes("connection timed out")
  ) {
    return `无法连接远程仓库，请检查网络连接或代理设置\n${msg}`;
  }
  if (lower.includes("non-fast-forward") || lower.includes("fetch first")) {
    return `推送被拒绝：远端存在本地尚无的提交，请先拉取（Pull）后再推送\n${msg}`;
  }
  if (lower.includes("overwritten by merge") || lower.includes("overwritten by checkout")) {
    return `工作区存在未提交的修改会与目标分支冲突，请先提交或贮藏（Stash）\n${msg}`;
  }
  if (lower.includes("conflict") && !msg.includes("冲突")) {
    return `操作遇到冲突，请在顶部横幅或侧栏解决冲突后继续\n${msg}`;
  }
  return msg;
}

/**
 * 规整面向用户的错误提示，并尽力写入本地日志文件（不阻塞主流程、不二次抛错）。
 */
export function reportError(source: string, e: unknown): string {
  const formatted = formatErrorMessage(e);
  if (!isCancelledError(e)) {
    const raw = rawErrorDetail(e);
    void api.logClientError("error", source, raw).catch(() => {
      /* 非 Tauri 运行时或日志目录不可写时静默忽略 */
    });
  }
  return formatted;
}
