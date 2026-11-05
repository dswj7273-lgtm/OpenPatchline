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

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
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
