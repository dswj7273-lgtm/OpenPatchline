/**
 * v0.8 / 8.2 弹窗组件测试：SettingsModal（草稿提交/分段控件/诊断入口）与
 * RebaseModal（动作选择 / 拖拽排序态 / 预览 / 提交计划）。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { SettingsModal } from "../components/Settings/SettingsModal";
import { RebaseModal } from "../components/GitLogView/RebaseModal";
import { useAppStore } from "../store/app";

vi.mock("../api/client", () => ({
  pickGitExecutable: vi.fn(),
  getDiagnostics: vi.fn(async () => "OpenPatchline v0.8.0\ngit: 2.50"),
  revealLogFile: vi.fn(),
  listRebaseCommits: vi.fn(),
  interactiveRebase: vi.fn(),
}));

const mockedApi = vi.mocked(api);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

const defaultSettings = {
  theme: "dark" as const,
  codeFontFamily: "",
  codeFontSize: 13,
  tabWidth: 4,
  defaultDiffMode: "split" as const,
  ignoreWhitespaceDefault: false,
  externalEditorCommand: null,
  gitExecutablePath: null,
};

describe("SettingsModal（v0.8 / 8.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      settingsOpen: true,
      settings: defaultSettings,
      updateSettings: vi.fn(async (patch) => {
        useAppStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
      }),
      closeSettings: vi.fn(() => useAppStore.setState({ settingsOpen: false })),
    });
  });

  it("segments switch theme and diff mode immediately", async () => {
    render(<SettingsModal />);
    const lightBtn = screen.getByRole("button", { name: "浅色" });
    fireEvent.click(lightBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(useAppStore.getState().settings.theme).toBe("light");

    const unifiedBtn = screen.getByRole("button", { name: "统一" });
    fireEvent.click(unifiedBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(useAppStore.getState().settings.defaultDiffMode).toBe("unified");
  });

  it("stepper adjusts font size with clamp and shortcut cheatsheet renders", async () => {
    render(<SettingsModal />);
    fireEvent.click(screen.getByLabelText("增大字号"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(useAppStore.getState().settings.codeFontSize).toBe(14);

    // 快捷键速查表来自 keymap 注册表
    expect(screen.getByText("快捷键")).toBeInTheDocument();
    expect(screen.getAllByText("打开仓库").length).toBeGreaterThan(0);
    expect(screen.getByText("切换分栏 / 统一")).toBeInTheDocument();
  });

  it("draft text input keeps typed spaces until blur (review 修复 #4 回归)", async () => {
    useAppStore.setState({
      settings: { ...defaultSettings, externalEditorCommand: null },
    });
    render(<SettingsModal />);
    const editorInput = screen.getByLabelText("外部编辑器命令");
    fireEvent.focus(editorInput);
    fireEvent.change(editorInput, { target: { value: "code --goto {path}:{line}" } });
    // 未失焦：不提交（后端规整不吞尾部空格的场景由失焦触发）
    expect(useAppStore.getState().settings.externalEditorCommand).toBeNull();
    fireEvent.blur(editorInput);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(useAppStore.getState().settings.externalEditorCommand).toBe("code --goto {path}:{line}");
  });

  it("copies diagnostics via clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("复制诊断信息"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("OpenPatchline v0.8.0"));
    expect(useAppStore.getState().notice).toContain("诊断信息已复制");
  });
});

describe("RebaseModal（v0.8 / 8.2）", () => {
  const commits = [
    {
      id: "1111111111111111111111111111111111111111",
      shortId: "1111111",
      subject: "feat: one",
      fullMessage: "feat: one",
      authorName: "A",
      authorEmail: "a@b.c",
      timestamp: 1,
    },
    {
      id: "2222222222222222222222222222222222222222",
      shortId: "2222222",
      subject: "feat: two",
      fullMessage: "feat: two",
      authorName: "B",
      authorEmail: "b@b.c",
      timestamp: 2,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listRebaseCommits.mockResolvedValue(commits);
    useAppStore.setState({
      repo: {
        id: "/tmp/repo",
        path: "/tmp/repo",
        name: "repo",
        headBranch: "main",
        headCommit: "2222222",
        state: "clean",
      },
      fileStatus: [],
      gitBusy: null,
      rebaseModalOpen: false,
      listRebaseCommits: vi.fn(async () => commits),
      interactiveRebase: vi.fn(async () => true),
      closeRebaseModal: vi.fn(),
    });
  });

  it("loads commits, changes action to drop, and previews resulting history", async () => {
    const onClose = vi.fn();
    render(<RebaseModal onClose={onClose} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(screen.getByText("feat: one")).toBeInTheDocument();
    expect(screen.getByText("feat: two")).toBeInTheDocument();

    // 打开预览：默认 2 条
    fireEvent.click(screen.getByRole("button", { name: /执行前预览/ }));
    expect(screen.getByText("2", { selector: ".rebase-preview-order" })).toBeInTheDocument();

    // 把 feat: two 设为丢弃
    const select = screen.getByLabelText("操作 2222222") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "drop" } });
    // 预览更新为 1 条，且被丢弃行加删除线样式
    expect(screen.getAllByText("feat: two")[0].closest(".rebase-item")).toHaveClass("is-dropped");
  });

  it("reorders via move buttons and submits reordered plan", async () => {
    const interactiveRebase = vi.fn(async () => true);
    useAppStore.setState({ interactiveRebase });
    const onClose = vi.fn();
    render(<RebaseModal onClose={onClose} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });

    // 把第一条（feat: one）下移 → 顺序变为 two, one（重排）
    fireEvent.click(screen.getAllByLabelText("下移")[0]);
    // 提示条出现（重排 → 走 git rebase -i 且可能冲突）
    expect(screen.getByText(/检测到重排或丢弃/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("执行整理"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(interactiveRebase).toHaveBeenCalledWith([
      { commitId: commits[1].id, action: "pick", message: null },
      { commitId: commits[0].id, action: "pick", message: null },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("reword falls back to original message when untouched (review 修复 #8 回归)", async () => {
    const interactiveRebase = vi.fn(async () => true);
    useAppStore.setState({ interactiveRebase });
    const onClose = vi.fn();
    render(<RebaseModal onClose={onClose} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });

    const select = screen.getByLabelText("操作 1111111") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "reword" } });
    // 不输入任何内容直接执行：沿用原说明而非空值
    const apply = screen.getByText("执行整理");
    expect(apply).not.toBeDisabled();
    fireEvent.click(apply);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(interactiveRebase).toHaveBeenCalledWith([
      { commitId: commits[0].id, action: "reword", message: "feat: one" },
      { commitId: commits[1].id, action: "pick", message: null },
    ]);
  });
});
