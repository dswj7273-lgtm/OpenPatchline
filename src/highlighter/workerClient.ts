/**
 * 语法高亮 Worker 客户端：管理 Web Worker 生命周期、LRU 结果缓存与请求取消。
 *
 * - 主线程仅依赖 extensions.ts（无 CodeMirror 解析器包体积开销）；
 * - 快速切文件导致旧请求未完成时，立即终止旧 Worker 并只为最新文件启动解析；
 * - 无 Worker 环境（如部分测试运行时）自动退回到动态导入 tokenizer。
 */

import { HIGHLIGHTABLE_EXTENSIONS } from "./extensions";
import type { HighlightRequest, HighlightResponse } from "./highlight.worker";
import type { TokenSpan } from "./tokenizer";

export interface SideTokens {
  left: TokenSpan[][];
  right: TokenSpan[][];
  degraded: boolean;
}

export const EMPTY_SIDE_TOKENS: SideTokens = {
  left: [],
  right: [],
  degraded: false,
};

const MAX_CACHE_ENTRIES = 24;
const cache = new Map<string, SideTokens>();

let worker: Worker | null = null;
let nextRequestId = 1;
let inFlightId: number | null = null;
let pendingResolve: ((res: SideTokens) => void) | null = null;

/** 轻量 32 位 FNV-1a 指纹，用于缓存键避免保存整份长文本。 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function cacheKey(left: string, right: string, langId: string): string {
  return `${langId}:${left.length}:${fnv1a(left)}:${right.length}:${fnv1a(right)}`;
}

function rememberCache(key: string, value: SideTokens): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** 同步查询内存 LRU 缓存（命中时可 0ms 渲染，无闪烁）。 */
export function getCachedHighlight(left: string, right: string, langId: string): SideTokens | null {
  if (!HIGHLIGHTABLE_EXTENSIONS.has(langId)) return EMPTY_SIDE_TOKENS;
  const key = cacheKey(left, right, langId);
  const hit = cache.get(key);
  if (!hit) return null;
  // 刷新 LRU 顺序
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function resetWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  inFlightId = null;
  pendingResolve = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
  w.addEventListener("message", (event: MessageEvent<HighlightResponse>) => {
    const { id, left, right, degraded } = event.data;
    if (id !== inFlightId) return;
    const resolve = pendingResolve;
    inFlightId = null;
    pendingResolve = null;
    resolve?.({ left, right, degraded });
  });
  w.addEventListener("error", () => {
    const resolve = pendingResolve;
    resetWorker();
    resolve?.(EMPTY_SIDE_TOKENS);
  });
  worker = w;
  return w;
}

/**
 * 异步请求双侧语法高亮，返回取消句柄。
 * 取消或新请求覆盖旧请求时，正在运行的旧 Worker 会被立即终止释放 CPU。
 */
export function requestHighlight(
  left: string,
  right: string,
  langId: string,
  onDone: (result: SideTokens) => void,
): () => void {
  if (!HIGHLIGHTABLE_EXTENSIONS.has(langId)) {
    onDone(EMPTY_SIDE_TOKENS);
    return () => {};
  }

  const key = cacheKey(left, right, langId);
  const hit = getCachedHighlight(left, right, langId);
  if (hit) {
    onDone(hit);
    return () => {};
  }

  let cancelled = false;
  const id = nextRequestId++;

  if (typeof Worker === "undefined") {
    void import("./tokenizer")
      .then(({ tokenizeDetailed }) => {
        if (cancelled) return;
        const l = tokenizeDetailed(left, langId);
        const r = tokenizeDetailed(right, langId);
        const res: SideTokens = {
          left: l.tokens,
          right: r.tokens,
          degraded: l.degraded || r.degraded,
        };
        rememberCache(key, res);
        onDone(res);
      })
      .catch(() => {
        if (!cancelled) onDone(EMPTY_SIDE_TOKENS);
      });
    return () => {
      cancelled = true;
    };
  }

  // 上一次计算尚未返回：直接终止旧 Worker，避免旧大文件阻塞队列。
  if (inFlightId !== null) {
    resetWorker();
  }

  const w = ensureWorker();
  inFlightId = id;
  pendingResolve = (res) => {
    if (cancelled) return;
    rememberCache(key, res);
    onDone(res);
  };

  const payload: HighlightRequest = { id, left, right, langId };
  w.postMessage(payload);

  return () => {
    cancelled = true;
    if (inFlightId === id) {
      resetWorker();
    }
  };
}
