/**
 * 首次启动引导（v1.0 / 10.4）：git 检测 → 配置全局身份 → 打开第一个仓库。
 *
 * - 打开时探测 git 版本与 user.name / user.email（`check_git_setup`）；
 * - 未配置身份时提供输入框，保存走 `set_git_identity`（全局 gitconfig）；
 * - 「开始使用」打开仓库选择对话框；跳过 / 完成都写入 onboardingDismissed，
 *   下次启动不再自动弹出（打开过任意仓库后也不再弹出）。
 */

import { useEffect, useState } from "react";
import * as api from "../../api/client";
import { useAppStore } from "../../store/app";
import { reportError } from "../../utils/errors";
import type { GitSetupInfo } from "../../types";
import { AlertIcon, CheckIcon, FolderOpenIcon, LogoMarkIcon } from "../Icons";
import "./OnboardingOverlay.css";

export function OnboardingOverlay() {
  const open = useAppStore((s) => s.onboardingOpen && !s.settingsOpen);
  const closeOnboarding = useAppStore((s) => s.closeOnboarding);
  const openRepo = useAppStore((s) => s.openRepo);
  const openSettings = useAppStore((s) => s.openSettings);

  const [info, setInfo] = useState<GitSetupInfo | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  // 打开时探测（每次打开重新探测，支持去设置改完 git 路径回来刷新）。
  useEffect(() => {
    if (!open) return;
    setInfo(null);
    let cancelled = false;
    void api
      .checkGitSetup()
      .then((fresh) => {
        if (cancelled) return;
        setInfo(fresh);
        setName(fresh.userName ?? "");
        setEmail(fresh.userEmail ?? "");
      })
      .catch((e) => {
        if (!cancelled) useAppStore.setState({ error: reportError("checkGitSetup", e) });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Escape 视为跳过（捕获阶段处理，避免触发全局返回路由）。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const dismiss = () => {
    void useAppStore.getState().updateSettings({ onboardingDismissed: true });
    closeOnboarding();
  };

  const startExploring = () => {
    dismiss();
    void openRepo();
  };

  const saveIdentity = async () => {
    setSaving(true);
    try {
      const fresh = await api.setGitIdentity(name, email);
      setInfo(fresh);
      useAppStore.setState({ notice: "已保存 git 用户信息（全局配置）" });
    } catch (e) {
      useAppStore.setState({ error: reportError("setGitIdentity", e) });
    } finally {
      setSaving(false);
    }
  };

  const gitReady = info?.gitVersion != null;
  const identityReady = info?.userName != null && info?.userEmail != null;
  const identityValid =
    name.trim().length > 0 && email.trim().includes("@") && !email.trim().includes(" ");

  return (
    <div
      className="onboarding-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="首次启动引导"
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="onboarding-modal">
        <header className="onboarding-header">
          <span className="onboarding-header__icon">
            <LogoMarkIcon />
          </span>
          <div>
            <h2 className="onboarding-title">欢迎使用 OpenPatchline</h2>
            <p className="onboarding-subtitle">检查本机 Git 环境，设置提交时使用的署名。</p>
          </div>
        </header>
        <div className="onboarding-body">
          <section className="onboarding-step" aria-label="检测 git">
            <div className="onboarding-step__head">
              Git 环境
              {info === null ? null : gitReady ? (
                <span className="onboarding-step__state is-ok">
                  <CheckIcon /> 已检测到
                </span>
              ) : (
                <span className="onboarding-step__state is-warn">
                  <AlertIcon /> 未检测到
                </span>
              )}
            </div>
            <p className="onboarding-step__desc">
              {info === null
                ? "正在检测…"
                : gitReady
                  ? info.gitVersion
                  : "未找到可用的 git。请安装 git，或在设置中指定 Git 可执行文件路径。"}
            </p>
            {!gitReady && info !== null && (
              <div>
                <button type="button" className="btn btn-sm" onClick={openSettings}>
                  打开设置
                </button>
              </div>
            )}
          </section>

          <section className="onboarding-step" aria-label="配置提交身份">
            <div className="onboarding-step__head">
              提交身份
              {info !== null && identityReady && (
                <span className="onboarding-step__state is-ok">
                  <CheckIcon /> 已配置
                </span>
              )}
            </div>
            <p className="onboarding-step__desc">保存后会更新全局 Git 用户名和邮箱。</p>
            <div className="onboarding-fields">
              <label className="onboarding-field">
                <span className="onboarding-field__label">用户名</span>
                <input
                  className="input"
                  aria-label="git 用户名"
                  value={name}
                  placeholder="你的名字"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="onboarding-field">
                <span className="onboarding-field__label">邮箱</span>
                <input
                  className="input"
                  type="email"
                  aria-label="git 邮箱"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={saving || !identityValid}
                  onClick={() => void saveIdentity()}
                >
                  {saving ? "保存中…" : "保存身份配置"}
                </button>
              </div>
            </div>
          </section>
        </div>
        <footer className="onboarding-footer">
          <button type="button" className="onboarding-skip" onClick={dismiss}>
            跳过，不再显示
          </button>
          <button type="button" className="btn btn-primary" onClick={startExploring}>
            <FolderOpenIcon /> 打开仓库，开始使用
          </button>
        </footer>
      </div>
    </div>
  );
}
