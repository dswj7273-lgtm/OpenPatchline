/**
 * 文件右键菜单公共项（v0.6 / 6.7）：在编辑器打开 / Finder 定位 / 复制路径。
 *
 * 由 Sidebar、DiffView、BlameView 共用；extra 可追加视图特有项（生成补丁等）。
 */

import type { ContextMenuItem } from "../components/ContextMenu/ContextMenu";
import { useAppStore } from "../store/app";
import { reportError } from "./errors";
import * as api from "../api/client";
import { copyText } from "./clipboard";

export function openFileContextMenu(
  open: (e: React.MouseEvent, items: ContextMenuItem[]) => void,
  e: React.MouseEvent,
  opts: {
    repoId: string;
    path: string;
    /** 编辑器跳转行号（缺省 1）。 */
    line?: number | null;
    /** 追加在公共项之后的视图特有项。 */
    extra?: ContextMenuItem[];
  },
): void {
  const { repoId, path, line, extra } = opts;
  const items: ContextMenuItem[] = [
    {
      key: "open-editor",
      label: "在外部编辑器中打开",
      onSelect: () => {
        api
          .openFileInEditor(repoId, path, line ?? null)
          .catch((err) => useAppStore.setState({ error: reportError("openFileInEditor", err) }));
      },
    },
    {
      key: "reveal",
      label: "在 Finder 中显示",
      onSelect: () => {
        api
          .revealPathInFinder(repoId, path)
          .catch((err) => useAppStore.setState({ error: reportError("revealPathInFinder", err) }));
      },
    },
    {
      key: "history",
      label: "查看文件历史",
      onSelect: () => {
        void useAppStore.getState().openFileHistory(path);
      },
    },
    {
      key: "copy-path",
      label: "复制路径",
      onSelect: () => {
        void copyText(path).then((ok) => {
          if (!ok) useAppStore.setState({ error: "复制路径失败：剪贴板不可用" });
        });
      },
    },
    ...(extra ?? []),
  ];
  open(e, items);
}
