/**
 * 剪贴板工具：优先异步 Clipboard API，失败（权限拒绝、窗口不在前台等）
 * 或不可用时降级为隐藏 textarea + execCommand（review 修复 #9：此前
 * writeText 一经存在立即返回 true，异步失败被吞、界面假报成功）。
 *
 * 返回是否复制成功；调用方据此展示"已复制"提示。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 落入下方同步兜底 */
    }
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
