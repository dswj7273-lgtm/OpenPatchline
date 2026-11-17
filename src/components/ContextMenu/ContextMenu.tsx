/**
 * 通用右键菜单（v0.6 / 6.7）：定位在指针处，点击外部 / Esc / 滚动关闭。
 *
 * 用法：`const menu = useContextMenu(); ... onContextMenu={(e) => menu.open(e, items)}`
 * 渲染：`{menu.render()}`（无菜单时返回 null）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./ContextMenu.css";

export interface ContextMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** 菜单出现后自动向上/向左翻转，避免溢出视口。 */
const MENU_MAX_HEIGHT = 320;

export function useContextMenu() {
  const [state, setState] = useState<MenuState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setState(null), []);

  const open = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);

  useEffect(() => {
    if (!state) return;
    const onPointerDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) close();
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    // 滚动（含虚拟滚动容器）时关闭，避免菜单悬空错位。
    const onScroll = () => close();
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [state, close]);

  const render = (): ReactNode => {
    if (!state) return null;
    const flipY = state.y + MENU_MAX_HEIGHT > window.innerHeight;
    const style: React.CSSProperties = {
      left: Math.min(state.x, window.innerWidth - 240),
      top: flipY ? undefined : state.y,
      bottom: flipY ? window.innerHeight - state.y : undefined,
    };
    return (
      <div className="ctx-menu" role="menu" ref={rootRef} style={style}>
        {state.items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`ctx-menu__item${item.danger ? " is-danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    );
  };

  return { open, close, render };
}
