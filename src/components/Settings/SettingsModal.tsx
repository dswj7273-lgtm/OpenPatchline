/**
 * 设置弹窗（v0.6 / 6.2）：主题、编辑器、Diff、外部工具与关于。
 *
 * 所有修改即时生效并持久化（updateSettings → 后端 settings.json），
 * 后端规整后的值会回写 store，保证展示值始终为最终生效值。
 */

import { useEffect, useRef, useState } from "react";
import { KEYBINDINGS, formatKeybinding, type KeybindingSpec } from "../../keyboard/keymap";
import { useAppStore } from "../../store/app";
import type { ThemePreference } from "../../types";
import { reportError } from "../../utils/errors";
import { copyText } from "../../utils/clipboard";
import * as api from "../../api/client";
import { CloseIcon, FolderIcon, SettingsIcon } from "../Icons";
import "./SettingsModal.css";

const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/** 字号与 Tab 宽度的合法区间（与 Rust 侧 clamp 保持一致）。 */
const FONT_SIZE_RANGE = { min: 10, max: 24 } as const;
const TAB_WIDTH_RANGE = { min: 1, max: 16 } as const;

/** 常见等宽字体建议（输入框 datalist）。 */
const FONT_SUGGESTIONS = [
  "JetBrains Mono",
  "SF Mono",
  "Menlo",
  "Fira Code",
  "Cascadia Code",
  "IBM Plex Mono",
  "Source Code Pro",
  "Consolas",
];

function clampInt(v: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(v)) return range.min;
  return Math.min(range.max, Math.max(range.min, Math.round(v)));
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="settings-segmented" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? "is-active" : ""}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 草稿态文本输入（review 修复）：输入期间维护本地 draft，
 * 失焦 / 回车时才提交 updateSettings —— 避免每次按键触发后端
 * 往返把尾部空格 trim 掉（`code --goto {path}:{line}` 无法输入）
 * 以及并发写竞态。值变化且未聚焦时同步外部值。
 */
function SettingsTextInput({
  value,
  onCommit,
  placeholder,
  spellCheck = false,
  list,
  ariaLabel,
}: {
  /** 当前生效值（null 展示为空串）。 */
  value: string | null;
  /** 提交草稿；返回 Promise 供按钮等调用方复用。 */
  onCommit: (draft: string) => void;
  placeholder?: string;
  spellCheck?: boolean;
  list?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [focused, setFocused] = useState(false);
  const valueStr = value ?? "";
  useEffect(() => {
    if (!focused) setDraft(valueStr);
  }, [valueStr, focused]);

  const commit = () => {
    if (draft !== valueStr) onCommit(draft);
  };

  return (
    <input
      type="text"
      className="input settings-input"
      aria-label={ariaLabel}
      placeholder={placeholder}
      spellCheck={spellCheck}
      list={list}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        // 先提交草稿再解除聚焦标记：解除后 effect 才能把外部值
        // （后端规整回写 / 浏览按钮选择的结果）同步进输入框
        //（review 修复 #4：此前 focused 一旦为真不再回读外部值）。
        commit();
        setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">{label}</span>
      <span className="settings-field__control">{children}</span>
      {hint && <span className="settings-field__hint">{hint}</span>}
    </label>
  );
}

export function SettingsModal() {
  const open = useAppStore((s) => s.settingsOpen);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, closeSettings]);

  if (!open) return null;

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      ref={dialogRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettings();
      }}
    >
      <div className="settings-modal">
        <div className="settings-header">
          <span className="settings-header__icon" aria-hidden="true">
            <SettingsIcon />
          </span>
          <h2 className="settings-title">设置</h2>
          <button type="button" className="icon-btn" aria-label="关闭设置" onClick={closeSettings}>
            <CloseIcon />
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section" aria-label="通用">
            <h3 className="settings-section__title">通用</h3>
            <Field label="主题" hint="跟随系统时随 macOS 外观自动切换">
              <Segmented<ThemePreference>
                ariaLabel="主题偏好"
                value={settings.theme}
                options={[
                  { value: "system", label: "跟随系统" },
                  { value: "dark", label: "深色" },
                  { value: "light", label: "浅色" },
                ]}
                onChange={(theme) => void updateSettings({ theme })}
              />
            </Field>
          </section>

          <section className="settings-section" aria-label="编辑器">
            <h3 className="settings-section__title">编辑器</h3>
            <Field label="代码字体" hint="留空使用内置等宽字体栈；需字体已安装">
              <SettingsTextInput
                ariaLabel="代码字体"
                list="settings-font-suggestions"
                placeholder="JetBrains Mono"
                value={settings.codeFontFamily}
                onCommit={(codeFontFamily) => void updateSettings({ codeFontFamily })}
              />
              <datalist id="settings-font-suggestions">
                {FONT_SUGGESTIONS.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Field>
            <Field label={`字号（${FONT_SIZE_RANGE.min}–${FONT_SIZE_RANGE.max} px）`}>
              <span className="settings-stepper">
                <button
                  type="button"
                  aria-label="减小字号"
                  disabled={settings.codeFontSize <= FONT_SIZE_RANGE.min}
                  onClick={() =>
                    void updateSettings({
                      codeFontSize: clampInt(settings.codeFontSize - 1, FONT_SIZE_RANGE),
                    })
                  }
                >
                  −
                </button>
                <span className="settings-stepper__value">{settings.codeFontSize}</span>
                <button
                  type="button"
                  aria-label="增大字号"
                  disabled={settings.codeFontSize >= FONT_SIZE_RANGE.max}
                  onClick={() =>
                    void updateSettings({
                      codeFontSize: clampInt(settings.codeFontSize + 1, FONT_SIZE_RANGE),
                    })
                  }
                >
                  +
                </button>
              </span>
            </Field>
            <Field label="Tab 宽度（列）">
              <input
                type="number"
                className="input settings-input settings-input--num"
                min={TAB_WIDTH_RANGE.min}
                max={TAB_WIDTH_RANGE.max}
                value={settings.tabWidth}
                onChange={(e) =>
                  void updateSettings({
                    tabWidth: clampInt(Number(e.target.value), TAB_WIDTH_RANGE),
                  })
                }
              />
            </Field>
          </section>

          <section className="settings-section" aria-label="Diff">
            <h3 className="settings-section__title">Diff</h3>
            <Field label="默认视图模式">
              <Segmented<"split" | "unified">
                ariaLabel="默认 Diff 视图模式"
                value={settings.defaultDiffMode}
                options={[
                  { value: "split", label: "分栏" },
                  { value: "unified", label: "统一" },
                ]}
                onChange={(defaultDiffMode) => void updateSettings({ defaultDiffMode })}
              />
            </Field>
            <Field label="忽略空白差异" hint="默认按此设置加载 Diff；视图内可临时切换">
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settings.ignoreWhitespaceDefault}
                  onChange={(e) =>
                    void updateSettings({ ignoreWhitespaceDefault: e.target.checked })
                  }
                />
                <span>比较时忽略行内空白变化</span>
              </label>
            </Field>
          </section>

          <section className="settings-section" aria-label="外部工具">
            <h3 className="settings-section__title">外部工具</h3>
            <Field
              label="外部编辑器命令"
              hint="支持 {path} 与 {line} 占位符，如：code --goto {path}:{line}；留空禁用；失焦或回车后保存"
            >
              <SettingsTextInput
                ariaLabel="外部编辑器命令"
                placeholder="code --goto {path}:{line}"
                value={settings.externalEditorCommand}
                onCommit={(draft) =>
                  void updateSettings({
                    externalEditorCommand: draft.trim() ? draft : null,
                  })
                }
              />
            </Field>
            <Field
              label="Git 可执行文件"
              hint="留空自动探测（PATH → Homebrew 常见位置）；失焦或回车后保存"
            >
              <span className="settings-input-with-icon">
                <SettingsTextInput
                  ariaLabel="Git 可执行文件路径"
                  placeholder="/opt/homebrew/bin/git"
                  value={settings.gitExecutablePath}
                  onCommit={(draft) =>
                    void updateSettings({
                      gitExecutablePath: draft.trim() ? draft : null,
                    })
                  }
                />
                <button
                  type="button"
                  className="icon-btn settings-input-picker"
                  aria-label="浏览选择 Git 可执行文件"
                  title="浏览选择 Git 可执行文件"
                  onClick={() => {
                    void api
                      .pickGitExecutable()
                      .then((picked) => {
                        if (picked) void updateSettings({ gitExecutablePath: picked });
                      })
                      .catch((e) =>
                        useAppStore.setState({ error: reportError("pickGitExecutable", e) }),
                      );
                  }}
                >
                  <FolderIcon />
                </button>
              </span>
            </Field>
          </section>

          <section className="settings-section" aria-label="快捷键">
            <h3 className="settings-section__title">快捷键</h3>
            <div className="settings-keymap">
              {Object.entries(
                KEYBINDINGS.reduce<Record<string, KeybindingSpec[]>>((acc, b) => {
                  (acc[b.group] ??= []).push(b);
                  return acc;
                }, {}),
              ).map(([group, bindings]) => (
                <div key={group} className="settings-keymap__group">
                  <div className="settings-keymap__group-name">{group}</div>
                  {bindings.map((b) => (
                    <div key={b.id} className="settings-keymap__row">
                      <span className="settings-keymap__label">
                        {b.label}
                        {b.scope && b.scope !== "Diff 视图" ? (
                          <span className="settings-keymap__scope">（{b.scope}）</span>
                        ) : null}
                      </span>
                      <kbd className="settings-keymap__kbd">{formatKeybinding(b)}</kbd>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section" aria-label="关于">
            <h3 className="settings-section__title">关于</h3>
            <div className="settings-about">
              <span className="settings-about__name">OpenPatchline</span>
              <span className="settings-about__version">版本 {APP_VERSION}</span>
            </div>
            <div className="settings-about__actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void api
                    .revealLogFile()
                    .catch((e) => useAppStore.setState({ error: reportError("revealLogFile", e) }));
                }}
              >
                打开日志目录
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void api
                    .getDiagnostics()
                    .then(copyText)
                    .then((ok) => {
                      if (ok) useAppStore.setState({ notice: "诊断信息已复制" });
                      else useAppStore.setState({ error: "复制诊断信息失败：剪贴板不可用" });
                    })
                    .catch((e) =>
                      useAppStore.setState({ error: reportError("getDiagnostics", e) }),
                    );
                }}
              >
                复制诊断信息
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
