/**
 * v0.8 / 8.2 组件测试：命令面板（渲染 / 模糊过滤 / 键盘执行）与
 * 提交图 Canvas（mock 2d context 的泳道绘制验证）。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom 无 scrollIntoView / canvas 实现，统一 polyfill / mock。
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
import { CommandPalette } from "../components/CommandPalette/CommandPalette";
import { CommitGraph } from "../components/GitLogView/CommitGraph";
import { useAppStore } from "../store/app";
import type { CommitGraphRow } from "../types";

function makeRow(id: string, lane: number, parents: string[] = [], color = 0): CommitGraphRow {
  return {
    commit: {
      id,
      shortId: id.slice(0, 7),
      message: `msg ${id}`,
      authorName: "A",
      authorEmail: "a@b.c",
      timestamp: 1700000000,
      parentIds: parents,
      refs: [],
      lane,
      laneColor: color,
    },
    laneIndex: lane,
    laneCount: 2,
    colorIndex: color,
    connectionsAbove: [],
    connectionsBelow: [],
  };
}

describe("CommandPalette (v0.6 / 6.4)", () => {
  let checkoutBranch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    checkoutBranch = vi.fn(async () => {});
    useAppStore.setState({
      commandPaletteOpen: true,
      repo: {
        id: "/tmp/repo",
        path: "/tmp/repo",
        name: "repo",
        headBranch: "main",
        headCommit: "abc1234",
        state: "clean",
      },
      theme: "dark",
      branches: [
        {
          name: "main",
          kind: "local",
          isCurrent: true,
          ahead: 0,
          behind: 0,
          upstream: null,
          tipCommit: "abc1234",
        },
        {
          name: "feature/ui",
          kind: "local",
          isCurrent: false,
          ahead: 2,
          behind: 1,
          upstream: "origin/feature/ui",
          tipCommit: "def5678",
        },
        {
          name: "bugfix/crash",
          kind: "local",
          isCurrent: false,
          ahead: 0,
          behind: 0,
          upstream: null,
          tipCommit: "999aaaa",
        },
      ],
      recentRepos: [
        {
          id: "/tmp/other",
          path: "/tmp/other",
          name: "other",
          lastOpenedAt: 1,
        },
      ],
      gitBusy: null,
      checkoutBranch: checkoutBranch as unknown as (name: string) => Promise<void>,
      fetchRemote: vi.fn(async () => {}),
      pushRepo: vi.fn(async () => {}),
      pullRepo: vi.fn(async () => {}),
      stashPush: vi.fn(async () => true),
      openSettings: vi.fn(),
      toggleTheme: vi.fn(),
      openRepo: vi.fn(async () => {}),
      openRebaseModal: vi.fn(),
    });
  });

  it("renders grouped commands and filters by fuzzy query", () => {
    const { rerender } = render(<CommandPalette />);
    // 空查询：分支切换与 Git 操作分组均可见
    expect(screen.getByText("切换到 feature/ui")).toBeInTheDocument();
    expect(screen.getByText("拉取远程（fetch）")).toBeInTheDocument();
    expect(screen.getByText("切换仓库 other")).toBeInTheDocument();

    // 模糊过滤：中文关键词只命中 fetch 条目
    const input = screen.getByPlaceholderText("搜索命令、分支、仓库…");
    fireEvent.change(input, { target: { value: "拉取远程" } });
    rerender(<CommandPalette />);
    expect(screen.queryByText("切换到 feature/ui")).not.toBeInTheDocument();
    expect(screen.queryByText("拉取远程（fetch）")).toBeInTheDocument();

    // 无匹配 → 空态
    fireEvent.change(input, { target: { value: "zzzzzz" } });
    rerender(<CommandPalette />);
    expect(screen.getByText("没有匹配的命令")).toBeInTheDocument();
  });

  it("executes highlighted command on Enter and closes palette", async () => {
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText("搜索命令、分支、仓库…");
    fireEvent.change(input, { target: { value: "crash" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // 动作经 requestAnimationFrame 延迟执行：等待帧回调
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(checkoutBranch).toHaveBeenCalledWith("bugfix/crash");
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
  });

  it("arrow keys move active item within filtered list", () => {
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText("搜索命令、分支、仓库…");
    // 过滤出多个分支
    fireEvent.change(input, { target: { value: "切换到" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThanOrEqual(2);
    const firstActive = options[0].getAttribute("aria-selected");
    expect(firstActive).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const optionsAfter = screen.getAllByRole("option");
    expect(optionsAfter[1].getAttribute("aria-selected")).toBe("true");
  });
});

describe("CommitGraph canvas (v0.8 / 8.2, mock 2d context)", () => {
  type CtxCalls = Record<string, number>;

  function mockCanvasContext() {
    const calls: CtxCalls = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(target, prop) {
        const key = String(prop);
        if (key === "canvas") {
          return { width: 400, height: 600 };
        }
        if (!(key in target)) {
          target[key] =
            key.startsWith("set") ||
            [
              "arc",
              "moveTo",
              "lineTo",
              "stroke",
              "fill",
              "beginPath",
              "clearRect",
              "fillRect",
              "bezierCurveTo",
            ].includes(key)
              ? vi.fn(() => {
                  calls[key] = (calls[key] ?? 0) + 1;
                })
              : vi.fn(() => undefined);
        }
        return target[key];
      },
      set(target, prop, value) {
        target[String(prop)] = value;
        return true;
      },
    };
    const ctx = new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  it("draws commit dots and lane connections via canvas API", async () => {
    const { ctx, calls } = mockCanvasContext();
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    const getContextMock = vi.fn(() => ctx);
    HTMLCanvasElement.prototype.getContext = getContextMock as never;

    try {
      const conn = { fromLane: 0, toLane: 1, colorIndex: 1, kind: "branchOut" } as const;
      const rows: CommitGraphRow[] = [
        { ...makeRow("aaaaaaa", 0, ["bbbbbbb"]), connectionsAbove: [conn] },
        makeRow("bbbbbbb", 1, ["ccccccc"], 1),
        makeRow("ccccccc", 0, []),
      ];
      const { container } = render(
        <CommitGraph rows={rows} graphWidth={90} scrollTop={0} viewportH={600} />,
      );
      // 绘制在 requestAnimationFrame 内执行：等待帧回调落地
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      // canvas 元素存在且已请求 2d context
      const canvas = container.querySelector("canvas");
      expect(canvas).not.toBeNull();
      expect(getContextMock).toHaveBeenCalledWith("2d");
      // 泳道绘制使用了 arc（提交点）与连线 path
      expect(calls.arc ?? 0).toBeGreaterThan(0);
      expect(
        (calls.moveTo ?? 0) + (calls.lineTo ?? 0) + (calls.bezierCurveTo ?? 0),
      ).toBeGreaterThan(0);
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetContext;
    }
  });
});
