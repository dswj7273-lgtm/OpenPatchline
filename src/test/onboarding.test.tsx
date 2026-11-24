/**
 * v1.0 / 10.4 首次启动引导：组件渲染 / 身份保存 / 跳过持久化，
 * 与 maybeShowOnboarding 的弹出判定。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { OnboardingOverlay } from "../components/Onboarding/OnboardingOverlay";
import { createAppStore, useAppStore } from "../store/app";
import { DEFAULT_APP_SETTINGS } from "../types";

vi.mock("../api/client", async (importOriginal) => {
  const { createApiMock } = await import("./mockApi");
  return createApiMock(await importOriginal<typeof import("../api/client")>(), {
    checkGitSetup: async () => ({
      gitVersion: "git version 2.50.1 (Apple Git-161)",
      userName: null,
      userEmail: null,
    }),
    setGitIdentity: async (name: string, email: string) => ({
      gitVersion: "git version 2.50.1 (Apple Git-161)",
      userName: name,
      userEmail: email,
    }),
  });
});

const mockedApi = vi.mocked(api);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OnboardingOverlay（v1.0 / 10.4）", () => {
  const openRepo = vi.fn(async () => {});
  const updateSettings = vi.fn(async () => {});

  beforeEach(() => {
    useAppStore.setState({
      onboardingOpen: true,
      openRepo,
      openSettings: vi.fn(),
      updateSettings,
    });
  });

  it("shows the detected Git version and empty identity inputs", async () => {
    render(<OnboardingOverlay />);
    expect(screen.getByText("欢迎使用 OpenPatchline")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/git version 2\.50\.1/)).toBeInTheDocument();
    });
    expect(screen.getByText("已检测到")).toBeInTheDocument();
    expect(screen.getByLabelText("git 用户名")).toHaveValue("");
    expect(screen.getByLabelText("git 邮箱")).toHaveValue("");
    // 身份未配置时不显示已配置徽标
    expect(screen.queryByText("已配置")).not.toBeInTheDocument();
  });

  it("warns when git is missing and offers settings entry", async () => {
    mockedApi.checkGitSetup.mockResolvedValueOnce({
      gitVersion: null,
      userName: null,
      userEmail: null,
    });
    const openSettings = vi.fn();
    useAppStore.setState({ openSettings });
    render(<OnboardingOverlay />);
    await waitFor(() => {
      expect(screen.getByText("未检测到")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(openSettings).toHaveBeenCalled();
  });

  it("saves identity via setGitIdentity and shows the configured badge", async () => {
    render(<OnboardingOverlay />);
    await waitFor(() => {
      expect(screen.getByText("已检测到")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("git 用户名"), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.change(screen.getByLabelText("git 邮箱"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存身份配置" }));
    await waitFor(() => {
      expect(mockedApi.setGitIdentity).toHaveBeenCalledWith("Ada Lovelace", "ada@example.com");
    });
    await waitFor(() => {
      expect(screen.getByText("已配置")).toBeInTheDocument();
    });
  });

  it("start button persists onboardingDismissed, closes, and opens a repo", async () => {
    render(<OnboardingOverlay />);
    fireEvent.click(screen.getByRole("button", { name: /打开仓库，开始使用/ }));
    await waitFor(() => {
      expect(useAppStore.getState().onboardingOpen).toBe(false);
    });
    expect(updateSettings).toHaveBeenCalledWith({ onboardingDismissed: true });
    expect(openRepo).toHaveBeenCalled();
  });

  it("skip link persists onboardingDismissed without opening a repo", async () => {
    render(<OnboardingOverlay />);
    fireEvent.click(screen.getByRole("button", { name: /跳过，不再显示/ }));
    await waitFor(() => {
      expect(useAppStore.getState().onboardingOpen).toBe(false);
    });
    expect(updateSettings).toHaveBeenCalledWith({ onboardingDismissed: true });
    expect(openRepo).not.toHaveBeenCalled();
  });
});

describe("maybeShowOnboarding（v1.0 / 10.4）", () => {
  it("opens only for fresh installs: no recent repos and not dismissed", () => {
    const store = createAppStore();
    store.setState({ recentRepos: [], settings: { ...DEFAULT_APP_SETTINGS } });
    store.getState().maybeShowOnboarding();
    expect(store.getState().onboardingOpen).toBe(true);

    // 已跳过 / 已完成 → 不弹出
    store.setState({
      onboardingOpen: false,
      settings: { ...DEFAULT_APP_SETTINGS, onboardingDismissed: true },
    });
    store.getState().maybeShowOnboarding();
    expect(store.getState().onboardingOpen).toBe(false);

    // 已有最近仓库 → 不弹出
    store.setState({
      recentRepos: [{ id: "/tmp/r", path: "/tmp/r", name: "r", lastOpenedAt: 1 }],
      settings: { ...DEFAULT_APP_SETTINGS },
    });
    store.getState().maybeShowOnboarding();
    expect(store.getState().onboardingOpen).toBe(false);
  });

  it("opening the first repository closes onboarding and persists the flag", async () => {
    const store = createAppStore();
    store.setState({ onboardingOpen: true });
    const updateSettings = vi.fn(async () => {});
    store.setState({ updateSettings });
    mockedApi.openRepository.mockResolvedValueOnce({ kind: "cancelled" });
    await store.getState().openRepo("");
    // 用户取消选择：仓库未打开，但引导不强制关闭
    expect(store.getState().onboardingOpen).toBe(true);

    mockedApi.openRepository.mockResolvedValueOnce({
      kind: "opened",
      repo: {
        id: "/tmp/demo",
        path: "/tmp/demo",
        name: "demo",
        headBranch: "main",
        headCommit: "1111111",
        state: "clean",
      },
    });
    await store.getState().openRepo("/tmp/demo");
    expect(store.getState().onboardingOpen).toBe(false);
    expect(updateSettings).toHaveBeenCalledWith({ onboardingDismissed: true });
  });
});
