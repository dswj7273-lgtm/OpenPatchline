/**
 * v0.8 / 8.2 分支覆盖补强：errors / appearance / fuzzyMatch / foldUtils 的
 * 边界分支（取消错误识别、主题解析、字体清洗、折叠阈值边界）。
 */
import { describe, expect, it, vi } from "vitest";
import { isCancelledError, reportError } from "../utils/errors";

// reportError 会异步写本地日志：mock IPC 客户端
vi.mock("../api/client", () => ({ logClientError: vi.fn(async () => {}) }));
import {
  applySettingsToDocument,
  resolveTheme,
  rowHeightForFontSize,
  systemPrefersDark,
} from "../utils/appearance";
import { fuzzyMatch } from "../keyboard/fuzzyMatch";
import { computeFoldRanges, isContextRow } from "../components/DiffView/foldUtils";
import type { AlignedRow, RowCell } from "../types";

function ctx(n: number): RowCell {
  return { kind: "context", lineno: n, content: `l${n}`, charRanges: [] };
}

describe("errors 边界（v0.8 / 8.2）", () => {
  it("identifies cancelled errors by wire code", () => {
    // 后端 AppError 序列化为 { code: "cancelled", message } 形态
    expect(isCancelledError({ code: "cancelled", message: "x" })).toBe(true);
    expect(isCancelledError(new Error("操作已取消"))).toBe(false);
    expect(isCancelledError("string error")).toBe(false);
    expect(isCancelledError({ code: "git", message: "boom" })).toBe(false);
    expect(isCancelledError(null)).toBe(false);
  });

  it("reportError extracts message from unknown throwables", () => {
    expect(reportError("s", "plain string")).toContain("plain string");
    const err = new Error("boom");
    expect(reportError("s", err)).toContain("boom");
    expect(reportError("s", { weird: 1 })).toBeTruthy();
  });
});

describe("appearance 边界（v0.8 / 8.2）", () => {
  it("row height clamps invalid font sizes to base", () => {
    expect(rowHeightForFontSize(0)).toBe(20);
    expect(rowHeightForFontSize(NaN)).toBe(20);
    expect(rowHeightForFontSize(13)).toBe(20);
    expect(rowHeightForFontSize(26)).toBe(40);
  });

  it("resolveTheme follows system preference and explicit values", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    // matchMedia 不可用 → system 视为深色
    expect(resolveTheme("system")).toBe(systemPrefersDark() ? "dark" : "light");
  });

  it("applySettingsToDocument writes CSS vars and sanitizes font family", () => {
    applySettingsToDocument(
      {
        theme: "dark",
        codeFontFamily: 'Bad"Font',
        codeFontSize: 15,
        tabWidth: 2,
        defaultDiffMode: "split",
        ignoreWhitespaceDefault: false,
        externalEditorCommand: null,
        gitExecutablePath: null,
      },
      "dark",
    );
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.getPropertyValue("--code-size")).toBe("15px");
    expect(root.style.getPropertyValue("--code-tab-size")).toBe("2");
    // 引号被清洗，未配置时清除内联覆盖
    expect(root.style.getPropertyValue("--font-code")).toContain("BadFont");
  });
});

describe("fuzzyMatch 边界（v0.8 / 8.2）", () => {
  it("handles empty/whitespace queries and prefix bonuses", () => {
    expect(fuzzyMatch("", "x")).toBe(0);
    expect(fuzzyMatch("   ", "x")).toBe(0);
    const exact = fuzzyMatch("a", "a");
    const tail = fuzzyMatch("a", "ba");
    expect(exact).not.toBeNull();
    expect(tail).not.toBeNull();
    expect(exact!).toBeGreaterThan(tail!);
    expect(fuzzyMatch("z", "abc")).toBeNull();
  });
});

describe("foldUtils 边界（v0.8 / 8.2）", () => {
  it("isContextRow rejects spacer and change rows", () => {
    expect(isContextRow({ left: ctx(1), right: ctx(1) } as AlignedRow)).toBe(true);
    expect(
      isContextRow({
        left: ctx(1),
        right: { kind: "added", lineno: 2, content: "x", charRanges: [] },
      } as AlignedRow),
    ).toBe(false);
    expect(isContextRow({ left: null, right: ctx(1) } as AlignedRow)).toBe(false);
  });

  it("does not fold runs at exactly the threshold boundary", () => {
    const run = 12; // FOLD_THRESHOLD(6) + 2*FOLD_CONTEXT(3) → 不折叠
    const rows = Array.from({ length: run }, (_, i) => ({
      left: ctx(i),
      right: ctx(i),
    })) as AlignedRow[];
    expect(computeFoldRanges(rows)).toEqual([]);
    // 多一行 → 折叠
    const longer = [...rows, { left: ctx(99), right: ctx(99) } as unknown as AlignedRow];
    expect(computeFoldRanges(longer)).toHaveLength(1);
  });
});
