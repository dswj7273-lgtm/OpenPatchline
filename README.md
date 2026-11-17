# OpenPatchline

开源 macOS Git 可视化客户端，以 **流畅的多泳道提交历史图** 和 **高可读性的左右分栏 Diff** 为核心体验。

![status](https://img.shields.io/badge/status-WIP-orange) ![platform](https://img.shields.io/badge/platform-macOS-blue) [![CI](https://github.com/dswj7273-lgtm/OpenPatchline/actions/workflows/ci.yml/badge.svg)](https://github.com/dswj7273-lgtm/OpenPatchline/actions/workflows/ci.yml)

## 下载安装

从 [Releases](https://github.com/dswj7273-lgtm/OpenPatchline/releases) 下载对应架构的 `.dmg`（Apple Silicon 选 `aarch64`，Intel 选 `x86_64`），拖入 Applications 即可。

> 当前构建未做 Apple 开发者签名/公证。首次打开若被 Gatekeeper 拦截，请前往 **系统设置 → 隐私与安全性** 点击 **仍要打开**，或在终端执行：
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/openpatchline.app
> ```

也可从源码构建：见下方 [开发](#开发) 一节。

## 功能（MVP）

- **Git 提交历史树** —— 泳道式分支图（Canvas 渲染）、merge/分叉拓扑、分支/Tag/HEAD 标签、增量分页加载、按作者/信息/分支过滤
- **左右分栏 Diff** —— 行精准对齐（spacer 占位）、行级 Histogram Diff、行内字符级高亮、Web Worker 异步语法高亮（CodeMirror Lezer，支持大文件降级）、横向同步/独立滚动、变更块导航、**变更概览导航条（右侧滚动条标记，点击一键跳转）**、Unified/Split 双模式
- **文件变更与工作区操作** —— 冲突/已暂存/工作区/未跟踪分组、目录树/文件级 stage/unstage、discard、commit/amend、cherry-pick/revert/reset、stash 栈管理
- **冲突状态感知与闭环** —— 自动识别 `MERGING / REBASING / CHERRY_PICKING / REVERTING` 状态、顶部横幅快捷继续/中止、冲突文件独立分组与一键标记解决
- **外部变更自动刷新** —— 监听 `.git` 目录（notify/FSEvents），外部编辑器或终端执行 commit、checkout、fetch、rebase 后自动刷新，无需手动刷新
- **远程操作与仓库切换** —— fetch / pull / pull --rebase / push / force-with-lease / push --tags 走 git CLI 复用系统凭证，支持实时流式进度与取消；分支面板与最近仓库切换器（自动清理失效路径）

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 核心引擎 | Rust（git2-rs / 自研 Histogram Diff / 泳道布局） |
| 界面 | React 19 + TypeScript + Vite |
| 状态 | Zustand |
| 高亮 | CodeMirror 6 Lezer |

## 开发

```bash
# 前置：Node 20+、Rust stable、Xcode CLT、cmake
npm install
npm run tauri dev    # 开发模式
npm run tauri build  # 产出 .app / .dmg

# 测试
cd src-tauri && cargo test   # Rust（diff 引擎 / 图布局 / git 服务）
npx tsc --noEmit             # 前端类型检查
```

## 路线图

- [x] Phase 0：脚手架与 CI
- [x] Phase 1：提交历史树（泳道图、分页、作者/分支/关键词过滤、最近仓库切换）
- [x] Phase 2：左右分栏 Diff（Histogram + 对齐 + 字符级 + Web Worker 语法高亮 + 横向滚动同步）
- [x] Phase 3：文件变更 + Git 操作（流式进度与取消、冲突状态感知与 Abort/Continue、stash/reset/cherry-pick）
- [ ] 后续规划：工程化测试基线、Hunk/行级 stage、三方合并冲突编辑器、Blame 视图、GitHub/GitLab 集成、Windows/Linux

## License

[Apache-2.0](./LICENSE) © OpenPatchline Contributors
