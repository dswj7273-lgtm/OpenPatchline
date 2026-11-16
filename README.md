# OpenPatchline

开源 macOS Git 可视化客户端，以 **IntelliJ IDEA 级别的提交历史图** 和 **左右分栏 Diff** 为核心体验。

![status](https://img.shields.io/badge/status-WIP-orange) ![platform](https://img.shields.io/badge/platform-macOS-blue) [![CI](https://github.com/starcommit/OpenPatchline/actions/workflows/ci.yml/badge.svg)](https://github.com/starcommit/OpenPatchline/actions/workflows/ci.yml)

## 下载安装

从 [Releases](https://github.com/starcommit/OpenPatchline/releases) 下载对应架构的 `.dmg`（Apple Silicon 选 `aarch64`，Intel 选 `x86_64`），拖入 Applications 即可。

> 当前构建未做 Apple 开发者签名/公证。首次打开若被 Gatekeeper 拦截，请前往 **系统设置 → 隐私与安全性** 点击 **仍要打开**，或在终端执行：
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/openpatchline.app
> ```

也可从源码构建：见下方 [开发](#开发) 一节。

## 功能（MVP 进行中）

- **Git 提交历史树** —— 泳道式分支图（Canvas 渲染）、merge/分叉拓扑、分支/Tag/HEAD 标签、增量分页加载、按作者/信息/分支过滤
- **左右分栏 Diff** —— 行精准对齐（spacer 占位）、行级 Histogram Diff、行内字符级高亮、语法高亮（CodeMirror Lezer）、同步滚动、变更块导航、**变更概览导航条（右侧滚动条标记，点击一键跳转）**、Unified/Split 双模式
- **文件变更与基础操作** —— staged/unstaged 分组、文件级 stage/unstage、commit
- **外部变更自动刷新** —— 监听 `.git` 目录（notify/FSEvents），IDEA / 终端等外部 commit、checkout、fetch 后自动刷新，无需手动刷新
- **拉取更新与分支切换** —— 获取（fetch）/拉取（pull）/**推送（push，新分支自动建立跟踪）**，走 git CLI 复用系统凭证；分支面板（本地/远程分组、ahead/behind 徽标、点击切换；远程分支检出为新本地跟踪分支）

完整设计文档见 [`docs/`](./docs/)（10 份：产品需求、技术选型、架构、Diff 引擎、Git 引擎、UI/UX、数据流、性能安全、路线图、测试策略）。

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
- [ ] Phase 1：提交历史树
- [ ] Phase 2：左右分栏 Diff
- [x] Phase 3：文件变更 + 基础 Git 操作（fetch/pull/push 走 git CLI 子进程）
- [ ] v2+：行级 stage、合并冲突编辑器、GitHub/GitLab 集成、Windows/Linux

## License

[Apache-2.0](./LICENSE) © OpenPatchline Contributors
