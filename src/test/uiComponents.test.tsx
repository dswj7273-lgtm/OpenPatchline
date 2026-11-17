import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
