import { describe, expect, it } from "vitest";
import { KEYBINDINGS, formatKeybinding, keybinding, matchesKeybinding } from "../keyboard/keymap";

function keyEvent(init: {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: init.key,
    metaKey: init.meta ?? false,
    ctrlKey: init.ctrl ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
  });
}

describe("keymap registry", () => {
  it("ids are unique and cover core actions", () => {
    const ids = KEYBINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["open-repo", "command-palette", "search", "refresh", "diff-mode"]) {
      expect(ids).toContain(id);
    }
  });

  it("matches modifier combinations exactly (no cross-talk)", () => {
    const openRepo = keybinding("open-repo")!; // ⌘O
    expect(matchesKeybinding(keyEvent({ key: "o", meta: true }), openRepo)).toBe(true);
    expect(matchesKeybinding(keyEvent({ key: "o", ctrl: true }), openRepo)).toBe(true);
    // Shift+⌘O 不是 ⌘O；⌥⌘O 也不是
    expect(matchesKeybinding(keyEvent({ key: "o", meta: true, shift: true }), openRepo)).toBe(
      false,
    );
    expect(matchesKeybinding(keyEvent({ key: "o", meta: true, alt: true }), openRepo)).toBe(false);
    expect(matchesKeybinding(keyEvent({ key: "p", meta: true }), openRepo)).toBe(false);

    // ⌘⇧T（主题）需要 Shift
    const theme = keybinding("toggle-theme")!;
    expect(matchesKeybinding(keyEvent({ key: "T", meta: true, shift: true }), theme)).toBe(true);
    expect(matchesKeybinding(keyEvent({ key: "t", meta: true }), theme)).toBe(false);
  });

  it("matches plain and alt-modified navigation keys", () => {
    const prevChange = keybinding("prev-change")!; // [
    expect(matchesKeybinding(keyEvent({ key: "[" }), prevChange)).toBe(true);
    // Shift+[ 产生 "{"：不接受（无修饰场景按字符比较）
    expect(matchesKeybinding(keyEvent({ key: "{", shift: true }), prevChange)).toBe(false);

    const prevAlt = keybinding("prev-change-alt")!; // ⌥↑
    expect(matchesKeybinding(keyEvent({ key: "ArrowUp", alt: true }), prevAlt)).toBe(true);
    expect(matchesKeybinding(keyEvent({ key: "ArrowUp" }), prevAlt)).toBe(false);

    // ⌘[ / ⌘] 切文件与裸 [ ] 跳转不冲突
    const prevFile = keybinding("prev-file")!;
    expect(matchesKeybinding(keyEvent({ key: "[", meta: true }), prevFile)).toBe(true);
    expect(matchesKeybinding(keyEvent({ key: "[" }), prevFile)).toBe(false);
  });

  it("formats display labels compactly", () => {
    const isMac = navigator.userAgent.includes("Mac");
    const label = formatKeybinding(keybinding("command-palette")!);
    expect(isMac ? label.startsWith("⌘") : label.startsWith("Ctrl+")).toBe(true);
    expect(formatKeybinding(keybinding("back")!)).toBe("Esc");
  });
});
