import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenize, tokenizeDetailed } from "../highlighter/tokenizer";
import { getCachedHighlight, requestHighlight } from "../highlighter/workerClient";

describe("tokenizer", () => {
  it("tokenizes TypeScript keywords and strings per line", () => {
    const code = 'const msg = "hello";\nreturn msg;';
    const res = tokenizeDetailed(code, "ts");
    expect(res.degraded).toBe(false);
    expect(res.tokens).toHaveLength(2);
    expect(
      res.tokens[0].some((t) => t.className === "tok-kw" && t.start === 0 && t.end === 5),
    ).toBe(true);
    expect(res.tokens[0].some((t) => t.className === "tok-str")).toBe(true);
    expect(
      res.tokens[1].some((t) => t.className === "tok-kw" && t.start === 0 && t.end === 6),
    ).toBe(true);
  });

  it("splits multiline block comments cleanly across lines", () => {
    const code = "/* first\nsecond */\nlet x = 1;";
    const lines = tokenize(code, "rs");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([{ start: 0, end: 8, className: "tok-com" }]);
    expect(lines[1]).toEqual([{ start: 0, end: 9, className: "tok-com" }]);
    expect(lines[2].some((t) => t.className === "tok-kw")).toBe(true);
  });

  it("returns empty token arrays for unsupported extensions", () => {
    const res = tokenizeDetailed("hello\nworld", "txt");
    expect(res).toEqual({ tokens: [[], []], degraded: false });
  });

  it("degrades cleanly when line count exceeds MAX_LINES or single line is minified", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bigLines = Array.from({ length: 5005 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const bigRes = tokenizeDetailed(bigLines, "ts");
    expect(bigRes.degraded).toBe(true);
    expect(bigRes.tokens).toHaveLength(5005);
    expect(bigRes.tokens[5002]).toEqual([]);
    warnSpy.mockRestore();

    const minified = `const x = "${"a".repeat(4500)}";`;
    const minRes = tokenizeDetailed(minified, "js");
    expect(minRes.degraded).toBe(true);
    expect(minRes.tokens).toEqual([[]]);
  });
});

describe("workerClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches results in memory and terminates superseded worker requests", () => {
    const terminate = vi.fn();
    const postMessage = vi.fn();
    const listeners: Array<(ev: MessageEvent) => void> = [];

    class MockWorker {
      addEventListener(type: string, cb: (ev: MessageEvent) => void) {
        if (type === "message") listeners.push(cb);
      }
      postMessage = postMessage;
      terminate = terminate;
    }

    vi.stubGlobal("Worker", MockWorker);

    const onFirst = vi.fn();
    const onSecond = vi.fn();

    requestHighlight("const a = 1;", "const a = 2;", "ts", onFirst);
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 第二个请求在前一个未完成时到达 → 应立即终止旧 Worker
    requestHighlight("const b = 1;", "const b = 2;", "ts", onSecond);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(2);

    const reqId = postMessage.mock.calls[1][0].id as number;
    for (const cb of listeners) {
      cb({
        data: { id: reqId, left: [[]], right: [[]], degraded: false },
      } as MessageEvent);
    }

    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledWith({ left: [[]], right: [[]], degraded: false });

    // 命中 LRU 缓存，同步返回
    expect(getCachedHighlight("const b = 1;", "const b = 2;", "ts")).toEqual({
      left: [[]],
      right: [[]],
      degraded: false,
    });
  });
});
