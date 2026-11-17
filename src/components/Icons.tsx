import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** OpenPatchline 品牌标识：分支泳道与补丁线几何图形。 */
export function LogoMarkIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 20 20" width="20" height="20" strokeWidth="1.75" {...props}>
      <circle cx="5.5" cy="4.5" r="2" />
      <circle cx="5.5" cy="15.5" r="2" />
      <circle cx="14.5" cy="10" r="2" />
      <path d="M5.5 6.5v7" />
      <path d="M5.5 6.5c0 2.5 3 3.5 7 3.5" />
    </Icon>
  );
}

export function FolderOpenIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8a1 1 0 0 1 .76.35L8.2 4.7a1 1 0 0 0 .76.35H12.5A1.5 1.5 0 0 1 14 6.55v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6.75" cy="6.75" r="4" />
      <path d="m9.75 9.75 3 3" />
    </Icon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="5" r="2.25" />
      <path d="M3.75 13c.35-2.15 1.9-3.35 4.25-3.35s3.9 1.2 4.25 3.35" />
    </Icon>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4" cy="3.25" r="1.5" />
      <circle cx="4" cy="12.75" r="1.5" />
      <circle cx="12" cy="3.25" r="1.5" />
      <path d="M4 4.75v6.5M12 4.75v1.5c0 1.65-1.35 2.5-3 2.5H7c-1.65 0-3 .85-3 2.5" />
    </Icon>
  );
}

export function CommitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M2 8h3.5M10.5 8H14" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.5 6 4.5 4.5L12.5 6" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.5 8H3.75M7.25 4.5 3.75 8l3.5 3.5" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8h8.75M8.75 4.5 12.25 8l-3.5 3.5" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 12.5V3.75M4.5 7.25 8 3.75l3.5 3.5" />
    </Icon>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v8.75M4.5 8.75 8 12.25l3.5-3.5" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.25 6A5.5 5.5 0 1 0 13 10.5" />
      <path d="M13.25 2.75V6h-3.5" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8h9" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.25 8.25 3 3 6.5-6.5" />
    </Icon>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="m5.5 8.2 1.7 1.7 3.4-3.6" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5.25v3.25" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="7.5" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </Icon>
  );
}

export function SplitViewIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="3" width="11.5" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </Icon>
  );
}

export function UnifiedViewIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="3" width="11.5" height="10" rx="1.5" />
      <path d="M4.75 6.25h6.5M4.75 9.75h4.5" />
    </Icon>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" />
    </Icon>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 10.25A6 6 0 0 1 5.75 2.5 6 6 0 1 0 13.5 10.25Z" />
    </Icon>
  );
}

/** 拉取（pull）：向下箭头落入托盘。 */
export function PullIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5v7M5 6.5 8 9.5l3-3" />
      <path d="M3 12.25h10" />
    </Icon>
  );
}

/** 推送（push）：向上箭头离开托盘。 */
export function PushIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 13.5v-7M5 9.5 8 6.5l3 3" />
      <path d="M3 12.25h10" />
    </Icon>
  );
}

/** 贮藏（stash）：层叠托盘。 */
export function StashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 5.25 8 2.5l5.5 2.75L8 8 2.5 5.25Z" />
      <path d="m2.5 8.25 5.5 2.75 5.5-2.75" />
      <path d="m2.5 11.25 5.5 2.75 5.5-2.75" />
    </Icon>
  );
}

/** 标签（tag）。 */
export function TagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 8.2V3.75a1 1 0 0 1 1-1H8.2a1 1 0 0 1 .7.29l4.06 4.06a1 1 0 0 1 0 1.41l-4.45 4.45a1 1 0 0 1-1.41 0L3.04 8.9a1 1 0 0 1-.29-.7Z" />
      <circle cx="5.75" cy="5.75" r="0.8" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** 撤销 / 回滚（revert / reset）。 */
export function UndoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.25 6.25H10a3.5 3.5 0 1 1 0 7H6.5" />
      <path d="M6.5 3.5 3.75 6.25 6.5 9" />
    </Icon>
  );
}

/** 丢弃 / 删除（discard / delete）。 */
export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4.5 4.5v8.25a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V4.5" />
      <path d="M6.75 7.25v3.75M9.25 7.25v3.75" />
    </Icon>
  );
}

/** 合并（merge）。 */
export function MergeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="10" r="1.5" />
      <path d="M4.5 5v6M4.5 6.5c0 2 3 3.5 5.5 3.5" />
    </Icon>
  );
}

/** 挑选提交（cherry-pick）。 */
export function CherryPickIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="11.5" r="2" />
      <circle cx="11.5" cy="11.5" r="2" />
      <path d="M4.5 9.5c0-3 1.5-5 3.5-6.5 2 1.5 3.5 3.5 3.5 6.5" />
      <path d="M8 3V1.75" />
    </Icon>
  );
}

/** Git 命令中心图标。 */
export function TerminalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <path d="m5 6.25 2.25 1.75L5 9.75M8.25 10h2.75" />
    </Icon>
  );
}

/** 链接（左右同步滚动）。 */
export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.6.6" />
      <path d="M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.6-.6" />
    </Icon>
  );
}

/** 断开链接（左右独立滚动）。 */
export function UnlinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.6 4.1 8.75 3.35a2.75 2.75 0 0 1 3.9 3.9l-1.4 1.4" />
      <path d="M6.4 11.9l-.85.75a2.75 2.75 0 0 1-3.9-3.9l1.4-1.4" />
      <path d="M2.5 2.5l11 11" />
    </Icon>
  );
}

/** 对比（分支 / 提交范围差异）。 */
export function CompareIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 5h8.5M9 2.5 11.5 5 9 7.5" />
      <path d="M13 11H4.5M7 8.5 4.5 11 7 13.5" />
    </Icon>
  );
}

/** 签名盾牌图标（GPG / SSH 验证）。 */
export function ShieldCheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.25 3.25 4.25v3.5c0 3 2 5 4.75 6 2.75-1 4.75-3 4.75-6v-3.5L8 2.25Z" />
      <path d="m5.75 8 1.5 1.5 3-3" />
    </Icon>
  );
}

/** 提交信息历史图标。 */
export function HistoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 6.25a5 5 0 1 1 1.1 5.3" />
      <path d="M3 3.25v3h3" />
      <path d="M8 5.25v3l2 1.2" />
    </Icon>
  );
}

/** 提交模板图标。 */
export function TemplateIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="2.25" width="10" height="11.5" rx="1.5" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </Icon>
  );
}

/** 整理 / 变基（interactive rebase）。 */
export function RebaseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="4" r="1.5" />
      <circle cx="4.5" cy="12" r="1.5" />
      <circle cx="11.5" cy="8" r="1.5" />
      <path d="M4.5 5.5v5M6 8h4" />
    </Icon>
  );
}

/** 日历（日期范围筛选）。 */
export function CalendarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" />
      <path d="M5.25 1.75v2.5M10.75 1.75v2.5M2.25 6.5h11.5" />
    </Icon>
  );
}

/** 三栏视图（三方合并冲突编辑器）。 */
export function ColumnsThreeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10M10 3v10" />
    </Icon>
  );
}

/** 代码/源码模式切换。 */
export function CodeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.75 4.75 2.5 8l3.25 3.25M10.25 4.75 13.5 8l-3.25 3.25M8.75 3.5l-1.5 9" />
    </Icon>
  );
}

/** 设置（齿轮）。 */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8a6.2 6.2 0 0 1 1.9.3l.4 1.7 1.5.9 1.7-.5a6.3 6.3 0 0 1 .9 1.6l-1.2 1.2v1.8l1.2 1.2a6.3 6.3 0 0 1-.9 1.6l-1.7-.5-1.5.9-.4 1.7a6.2 6.2 0 0 1-3.8 0l-.4-1.7-1.5-.9-1.7.5a6.3 6.3 0 0 1-.9-1.6l1.2-1.2V6.5L1.6 5.3a6.3 6.3 0 0 1 .9-1.6l1.7.5 1.5-.9.4-1.7A6.2 6.2 0 0 1 8 1.8Z" />
    </Icon>
  );
}

/** 命令面板。 */
export function CommandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 2.5a2 2 0 1 0 0 4h5a2 2 0 1 0 0-4 2 2 0 0 0-2 2v3a2 2 0 1 1-1 0v-3a2 2 0 0 0-2-2Z" />
      <path d="M5.5 9.5h5M8 6.5v3" />
    </Icon>
  );
}

/** 在外部编辑器打开。 */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 3H4a1.5 1.5 0 0 0-1.5 1.5V12A1.5 1.5 0 0 0 4 13.5h7.5A1.5 1.5 0 0 0 13 12V9.5" />
      <path d="M9 2.5h4.5V7M13.5 2.5 8 8" />
    </Icon>
  );
}

/** 文件夹 / Finder 定位。 */
export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 4.25A1.25 1.25 0 0 1 3.25 3H6l1.25 1.5h5.5A1.25 1.25 0 0 1 14 5.75v6A1.25 1.25 0 0 1 12.75 13h-9.5A1.25 1.25 0 0 1 2 11.75v-7.5Z" />
    </Icon>
  );
}
