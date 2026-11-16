/**
 * 语法高亮 Web Worker：在后台线程运行 CodeMirror 6 / Lezer 解析，
 * 避免大文件切换阻塞 UI 主线程。
 */

import { tokenizeDetailed, type TokenSpan } from "./tokenizer";

export interface HighlightRequest {
  id: number;
  left: string;
  right: string;
  langId: string;
}

export interface HighlightResponse {
  id: number;
  left: TokenSpan[][];
  right: TokenSpan[][];
  degraded: boolean;
}

const scope = globalThis as unknown as {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<HighlightRequest>) => void,
  ) => void;
  postMessage: (message: HighlightResponse) => void;
};

scope.addEventListener("message", (event) => {
  const { id, left, right, langId } = event.data;
  const leftRes = tokenizeDetailed(left, langId);
  const rightRes = tokenizeDetailed(right, langId);
  scope.postMessage({
    id,
    left: leftRes.tokens,
    right: rightRes.tokens,
    degraded: leftRes.degraded || rightRes.degraded,
  });
});
