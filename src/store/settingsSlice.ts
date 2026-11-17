/**
 * 应用设置 Slice（v0.6 / 6.2）：加载、乐观更新与文档应用。
 *
 * - 启动时从后端读取（settings.json）；首次运行（fresh）时把旧版
 *   localStorage 主题一次性迁移进后端配置；
 * - 所有修改即时生效并持久化（写入失败回滚并提示）；
 * - `theme` 保存"实际生效主题"（system 偏好已解析），供样式与切换按钮使用；
 *   系统主题变化时由 App 层监听并调用 `syncSystemTheme` 同步。
 */

import * as api from "../api/client";
import { DEFAULT_APP_SETTINGS, type AppSettings, type ThemePreference } from "../types";
import { reportError, type AppSlice, type SettingsSlice } from "./types";
import { applySettingsToDocument, resolveTheme, rowHeightForFontSize } from "../utils/appearance";

/** 读取旧版本地主题偏好（仅首次迁移与首帧提示用）。 */
function legacyThemeHint(): ThemePreference | null {
  try {
    const saved = window.localStorage.getItem("openpatchline:theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* 隐私模式或禁用存储时忽略 */
  }
  return null;
}

export const createSettingsSlice: AppSlice<SettingsSlice> = (set, get) => {
  /** 应用 settings → resolved theme + CSS 变量 + 行高派生值。 */
  function applySettings(settings: AppSettings): void {
    const theme = resolveTheme(settings.theme);
    set({ settings, theme, codeRowHeight: rowHeightForFontSize(settings.codeFontSize) });
    applySettingsToDocument(settings, theme);
  }

  return {
    settings: DEFAULT_APP_SETTINGS,
    settingsLoaded: false,
    theme: resolveTheme(DEFAULT_APP_SETTINGS.theme),
    codeRowHeight: rowHeightForFontSize(DEFAULT_APP_SETTINGS.codeFontSize),

    loadSettings: async () => {
      try {
        const payload = await api.getAppSettings();
        let settings = payload.config;
        // 首次运行：沿用旧版本地主题偏好，避免老用户设置被重置。
        if (payload.fresh) {
          const legacy = legacyThemeHint();
          if (legacy) {
            settings = { ...settings, theme: legacy };
            void api.setAppSettings(settings).catch(() => {
              /* 迁移持久化失败不阻断启动 */
            });
          }
        }
        applySettings(settings);
        set({ settingsLoaded: true });
      } catch (e) {
        // 后端读取失败：保持默认值继续运行（不阻塞应用）。
        applySettings(DEFAULT_APP_SETTINGS);
        set({ settingsLoaded: true, error: reportError("loadSettings", e) });
      }
    },

    updateSettings: async (patch) => {
      const prev = get().settings;
      const next: AppSettings = { ...prev, ...patch };
      applySettings(next);
      try {
        const saved = await api.setAppSettings(next);
        applySettings(saved);
      } catch (e) {
        applySettings(prev);
        set({ error: reportError("updateSettings", e) });
      }
    },

    setTheme: (pref) => {
      void get().updateSettings({ theme: pref });
    },

    toggleTheme: () => {
      const current = get().theme;
      void get().updateSettings({ theme: current === "dark" ? "light" : "dark" });
    },

    syncSystemTheme: () => {
      const { settings, theme } = get();
      if (settings.theme !== "system") return;
      const resolved = resolveTheme("system");
      if (resolved !== theme) {
        set({ theme: resolved });
        applySettingsToDocument(settings, resolved);
      }
    },
  };
};
