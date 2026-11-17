#!/usr/bin/env node
/**
 * 版本号统一提升脚本（docs/11 §三 6.1）。
 *
 * 用法：npm run version:bump [-- patch|minor|major|<具体版本号>]
 *
 * 同步更新三处版本号，保证一致：
 * - package.json          → version
 * - src-tauri/Cargo.toml  → [package] version
 * - src-tauri/tauri.conf.json → version
 *
 * 不修改 Cargo.lock（下次 cargo 构建会自动同步）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = {
  "package.json": (content, next) =>
    content.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`),
  "src-tauri/Cargo.toml": (content, next) =>
    content.replace(
      /(^version\s*=\s*)"[^"]+"/m,
      `$1"${next}"`,
    ),
  "src-tauri/tauri.conf.json": (content, next) =>
    content.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`),
};

function readVersion(relPath) {
  if (relPath.endsWith("Cargo.toml")) {
    const m = readFileSync(join(ROOT, relPath), "utf8").match(/^version\s*=\s*"([^"]+)"/m);
    if (!m) throw new Error(`无法在 ${relPath} 中解析 version 字段`);
    return m[1];
  }
  const json = JSON.parse(readFileSync(join(ROOT, relPath), "utf8"));
  if (!json.version) throw new Error(`${relPath} 缺少 version 字段`);
  return json.version;
}

function bump(current, mode) {
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(mode)) return mode;
  const parts = current.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
    throw new Error(`无法解析当前版本号 ${current}`);
  }
  switch (mode) {
    case "major":
      return `${parts[0] + 1}.0.0`;
    case "minor":
      return `${parts[0]}.${parts[1] + 1}.0`;
    case "patch":
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    default:
      throw new Error(`无效的版本参数：${mode}（可用 patch / minor / major / x.y.z）`);
  }
}

const mode = process.argv[2] ?? "patch";
const current = readVersion("package.json");
const next = bump(current, mode);

for (const [relPath, replace] of Object.entries(FILES)) {
  const abs = join(ROOT, relPath);
  const content = readFileSync(abs, "utf8");
  const updated = replace(content, next);
  if (updated === content) throw new Error(`${relPath} 中未找到可替换的版本号`);
  writeFileSync(abs, updated);
  console.log(`✔ ${relPath}: ${current} → ${next}`);
}
