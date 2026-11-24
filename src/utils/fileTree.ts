/**
 * 把扁平变更路径收成 IDEA「Compact Middle Packages」式目录树：
 * 只有一个子目录、自身没有文件的中间层合并成 `a/b/c`，
 * 仓库根节点不并入子目录。
 */

export interface CompactFileLeaf<T> {
  file: T;
  /** 在原始文件数组中的下标，打开 diff 时沿用。 */
  index: number;
  name: string;
}

export interface CompactFileDir<T> {
  /** 折叠状态键。根节点为空串。 */
  id: string;
  /** 展示名。根节点为仓库名，其余为压缩后的路径段，如 `src/main/java`。 */
  label: string;
  /** 相对仓库根的目录路径。根节点为空串。 */
  path: string;
  /**
   * 文件数后面的灰色位置提示。
   * 根的直接子目录用仓库名，更深的节点用父目录路径；根节点为空。
   */
  location: string;
  fileCount: number;
  dirs: CompactFileDir<T>[];
  files: CompactFileLeaf<T>[];
}

interface MutableDir<T> {
  label: string;
  path: string;
  parentPath: string;
  dirs: MutableDir<T>[];
  files: CompactFileLeaf<T>[];
}

function compareName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function findOrCreate<T>(parent: MutableDir<T>, name: string): MutableDir<T> {
  let child = parent.dirs.find((dir) => dir.label === name);
  if (!child) {
    child = {
      label: name,
      path: parent.path ? `${parent.path}/${name}` : name,
      parentPath: parent.path,
      dirs: [],
      files: [],
    };
    parent.dirs.push(child);
  }
  return child;
}

/** 压缩单链中间目录。根节点保持为仓库名，不与唯一子目录合并。 */
function compact<T>(node: MutableDir<T>, isRoot: boolean) {
  for (const child of node.dirs) compact(child, false);
  if (isRoot) return;
  while (node.files.length === 0 && node.dirs.length === 1) {
    const child = node.dirs[0];
    node.label = `${node.label}/${child.label}`;
    node.path = child.path;
    node.dirs = child.dirs;
    node.files = child.files;
  }
}

function finalize<T>(node: MutableDir<T>, isRoot: boolean, rootLabel: string): CompactFileDir<T> {
  const dirs = node.dirs
    .map((dir) => finalize(dir, false, rootLabel))
    .sort((a, b) => compareName(a.label, b.label));
  const files = [...node.files].sort((a, b) => compareName(a.name, b.name));
  const fileCount = files.length + dirs.reduce((sum, dir) => sum + dir.fileCount, 0);
  return {
    id: node.path,
    label: node.label,
    path: node.path,
    location: isRoot ? "" : node.parentPath || rootLabel,
    fileCount,
    dirs,
    files,
  };
}

export function buildCompactFileTree<T extends { path: string }>(
  files: readonly T[],
  rootLabel: string,
): CompactFileDir<T> {
  const label = rootLabel.trim() || "仓库";
  const root: MutableDir<T> = { label, path: "", parentPath: "", dirs: [], files: [] };

  files.forEach((file, index) => {
    const segments = file.path.split("/").filter(Boolean);
    const dirSegments = segments.slice(0, -1);
    const name = segments.length > 0 ? segments[segments.length - 1] : file.path;
    let node = root;
    for (const segment of dirSegments) node = findOrCreate(node, segment);
    node.files.push({ file, index, name });
  });

  compact(root, true);
  return finalize(root, true, label);
}
