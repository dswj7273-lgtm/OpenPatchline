import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlameView } from "../components/BlameView/BlameView";
import { ConflictView } from "../components/ConflictView/ConflictView";
import { GitLogView } from "../components/GitLogView/GitLogView";
import { CommitComposer } from "../components/Sidebar/CommitComposer";
import { useAppStore } from "../store/app";
import { EMPTY_LOG_FILTER } from "../store/types";

describe("CommitComposer (4.4 enhancements)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({
      repo: {
        id: "/tmp/repo",
        path: "/tmp/repo",
        name: "repo",
        headBranch: "main",
        headCommit: "abc1234",
        state: "clean",
      },
      fileStatus: [{ path: "a.ts", staged: "modified", unstaged: null, conflicted: false }],
      graphRows: [
        {
          commit: {
            id: "abc1234",
            shortId: "abc1234",
            message: "feat: initial",
            authorName: "Alice",
            authorEmail: "alice@example.com",
            timestamp: 1700000000,
            parentIds: [],
            refs: [],
            lane: 0,
            laneColor: 0,
          },
          laneIndex: 0,
          laneCount: 1,
          colorIndex: 0,
          connectionsAbove: [],
          connectionsBelow: [],
        },
      ],
      commitMetadata: {
        commitTemplate: "feat: custom tpl",
        gpgSignEnabled: true,
        signingKey: "KEY123",
        gpgFormat: "ssh",
      },
      commitHistory: ["chore: previous message"],
      gitBusy: null,
      createCommit: vi.fn(async () => {}),
      amendCommit: vi.fn(async () => true),
    });
  });

  it("supports history recall, commit template, Co-authored-by, and GPG signing toggle", () => {
    render(<CommitComposer />);

    const textarea = screen.getByLabelText("提交信息") as HTMLTextAreaElement;
    expect(screen.getByText("SSH 签名")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "模板" }));
    fireEvent.click(screen.getByText("feat: custom tpl"));
    expect(textarea.value).toBe("feat: custom tpl");

    fireEvent.click(screen.getByRole("button", { name: "Co-author" }));
    fireEvent.click(screen.getByText("Alice"));
    expect(textarea.value).toBe("feat: custom tpl\n\nCo-authored-by: Alice <alice@example.com>");

    fireEvent.click(screen.getByRole("button", { name: "历史" }));
    fireEvent.click(screen.getByText("chore: previous message"));
    expect(textarea.value).toBe("chore: previous message");

    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(useAppStore.getState().createCommit).toHaveBeenCalledWith(
      "chore: previous message",
      true,
    );
  });

  it("consolidates log toolbar actions into one Git 操作 menu with ahead/behind/stash badges", () => {
    useAppStore.setState({
      branches: [
        {
          name: "main",
          kind: "local",
          isCurrent: true,
          upstream: "origin/main",
          ahead: 1,
          behind: 2,
          tipCommit: "abc1234",
        },
      ],
      stashes: [{ index: 0, id: "deadbeef", message: "wip" }],
      selectedCommitId: null,
      compareRange: null,
    });

    render(<GitLogView />);

    const actionGroup = screen.getByRole("group", { name: "Git 操作入口" });
    const buttons = actionGroup.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Git 操作");
    expect(buttons[0]).toHaveTextContent("↓2");
    expect(buttons[0]).toHaveTextContent("↑1");

    fireEvent.click(buttons[0]);
    const dialog = screen.getByRole("dialog", { name: "Git 命令中心" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "同步" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "分支/标签" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "贮藏 (1)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "撤销/清理" })).toBeInTheDocument();
  });

  it("applies custom date range filter in GitLogView omnibar", () => {
    vi.useFakeTimers();
    const setLogFilter = vi.fn();
    useAppStore.setState({
      graphRows: [],
      selectedCommitId: null,
      compareRange: null,
      logFilter: EMPTY_LOG_FILTER,
      setLogFilter,
    });

    render(<GitLogView />);
    fireEvent.click(screen.getByRole("button", { name: "按日期范围筛选" }));
    const sinceInput = screen.getByLabelText("起始日期") as HTMLInputElement;
    const untilInput = screen.getByLabelText("结束日期") as HTMLInputElement;
    fireEvent.change(sinceInput, { target: { value: "2026-11-01" } });
    fireEvent.change(untilInput, { target: { value: "2026-11-10" } });

    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(screen.getByText("2026-11-01 ~ 2026-11-10")).toBeInTheDocument();
    expect(setLogFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        since: expect.any(Number),
        until: expect.any(Number),
      }),
    );
    vi.useRealTimers();
  });

  it("renders ConflictView guided resolution, marker guard, and save+stage action", () => {
    const resolveConflictFile = vi.fn(async () => true);
    useAppStore.setState({
      conflictPath: "src/index.ts",
      conflictLoading: false,
      gitBusy: null,
      conflictDetail: {
        path: "src/index.ts",
        isBinary: false,
        tooLarge: false,
        baseExists: true,
        oursExists: true,
        theirsExists: true,
        workdirExists: true,
        baseContent: "const v = 0;\n",
        oursContent: "const v = 1;\n",
        theirsContent: "const v = 2;\n",
        workdirContent: "<<<<<<< HEAD\nconst v = 1;\n=======\nconst v = 2;\n>>>>>>> feat\n",
        oursLabel: "HEAD",
        theirsLabel: "feat",
      },
      resolveConflictFile,
    });

    render(<ConflictView />);
    expect(screen.getByText("1 处冲突待解决")).toBeInTheDocument();

    // 未解决冲突直接点标记已解决应出现确认提示
    fireEvent.click(screen.getByRole("button", { name: /保存并标记已解决/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("冲突标记");
    expect(resolveConflictFile).not.toHaveBeenCalled();

    // 采用 Ours 后标记清除并允许直接保存暂存
    fireEvent.click(screen.getByRole("button", { name: "采用 Ours (HEAD)" }));
    expect(screen.getByText("冲突标记已清除")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /保存并标记已解决/ }));
    expect(resolveConflictFile).toHaveBeenCalledWith("src/index.ts", "const v = 1;\n", true, false);
  });

  it("renders BlameView hunks and supports parent-commit blame drilldown", () => {
    const openFileBlame = vi.fn(async () => {});
    useAppStore.setState({
      blameLoading: false,
      blameHistory: [],
      blameReturnView: "log",
      openFileBlame,
      blameResult: {
        path: "src/main.ts",
        commitId: "2222222222222222",
        isBinary: false,
        tooLarge: false,
        commits: {
          "2222222222222222": {
            id: "2222222222222222",
            shortId: "2222222",
            authorName: "Alice",
            authorEmail: "alice@example.com",
            timestamp: 1700000000,
            summary: "feat: update line",
            parentIds: ["1111111111111111"],
            isUncommitted: false,
          },
        },
        lines: [
          {
            lineNo: 1,
            origLineNo: 1,
            origPath: null,
            commitId: "2222222222222222",
            content: "console.log('hi');",
          },
        ],
      },
    });

    render(<BlameView />);
    expect(screen.getByText("1 行 · 1 次提交")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /2222222/ }));
    expect(screen.getByRole("region", { name: "选中行提交详情" })).toHaveTextContent(
      "feat: update line",
    );

    fireEvent.click(screen.getByRole("button", { name: /追溯父提交 Blame/ }));
    expect(openFileBlame).toHaveBeenCalledWith("src/main.ts", "1111111111111111", {
      pushHistory: true,
    });
  });
});
