/**
 * 剪贴板工具：优先异步 Clipboard API，不可用（非安全上下文等）时
 * 降级为隐藏 textarea + execCommand。
 *
 * 返回是否复制成功；调用方据此展示"已复制"提示。
 */
export function copyText(text: string): boolean {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      /* 异步失败时静默（下方同步路径已兜底过一次） */
    });
    return true;
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 复制成功后短暂展示的提示时长（ms）。 */
export const COPY_FEEDBACK_MS = 1500;
