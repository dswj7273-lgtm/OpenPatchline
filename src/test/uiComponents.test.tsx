import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitLogView } from "../components/GitLogView/GitLogView";
import { CommitComposer } from "../components/Sidebar/CommitComposer";
import { useAppStore } from "../store/app";

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
});
