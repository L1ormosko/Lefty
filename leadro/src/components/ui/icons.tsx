import type { SVGProps } from "react";

/**
 * Minimal inline icon set. Icons are decorative (aria-hidden): meaning is always carried by
 * adjacent text. Directional icons flip in RTL via the `rtl:` variant.
 */
type IconProps = SVGProps<SVGSVGElement>;

function Base(props: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

export const CheckCircleIcon = (p: IconProps) => (
  <Base {...p}><circle cx="10" cy="10" r="8" /><path d="m6.5 10 2.5 2.5 4.5-5" /></Base>
);
export const AlertTriangleIcon = (p: IconProps) => (
  <Base {...p}><path d="M10 3 1.5 17h17z" /><path d="M10 8v4M10 14.5v.01" /></Base>
);
export const XCircleIcon = (p: IconProps) => (
  <Base {...p}><circle cx="10" cy="10" r="8" /><path d="m7 7 6 6M13 7l-6 6" /></Base>
);
export const InfoIcon = (p: IconProps) => (
  <Base {...p}><circle cx="10" cy="10" r="8" /><path d="M10 9v5M10 6v.01" /></Base>
);
export const DotIcon = (p: IconProps) => (
  <Base {...p}><circle cx="10" cy="10" r="4" fill="currentColor" /></Base>
);
/** Points toward "next" (right in LTR, left in RTL); `back` points toward "previous". */
export const ChevronIcon = ({ className, back, ...p }: IconProps & { back?: boolean }) => (
  <Base className={`${back ? "rotate-180 rtl:rotate-0" : "rtl:rotate-180"} ${className ?? ""}`} {...p}>
    <path d="m7 4 6 6-6 6" />
  </Base>
);
export const SearchIcon = (p: IconProps) => (
  <Base {...p}><circle cx="9" cy="9" r="6" /><path d="m14 14 4 4" /></Base>
);
export const SortIcon = (p: IconProps) => (
  <Base {...p}><path d="m6 8 4-4 4 4M6 12l4 4 4-4" /></Base>
);
export const SortAscIcon = (p: IconProps) => (
  <Base {...p}><path d="m5 12 5-6 5 6" /></Base>
);
export const SortDescIcon = (p: IconProps) => (
  <Base {...p}><path d="m5 8 5 6 5-6" /></Base>
);
export const InboxIcon = (p: IconProps) => (
  <Base {...p}><path d="M2 11h5l1 2h4l1-2h5M2 11l2-7h12l2 7v5H2z" /></Base>
);
