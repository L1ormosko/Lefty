import type { ReactNode } from "react";
import { cx } from "./cx";
import { AlertTriangleIcon, CheckCircleIcon, DotIcon, InfoIcon, XCircleIcon } from "./icons";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const toneClasses: Record<StatusTone, string> = {
  success: "bg-success-soft text-success border-success-line",
  warning: "bg-warning-soft text-warning border-warning-line",
  danger: "bg-danger-soft text-danger border-danger-line",
  info: "bg-info-soft text-info border-info-line",
  neutral: "bg-neutral-soft text-neutral border-neutral-line",
};

const toneIcons: Record<StatusTone, ReactNode> = {
  success: <CheckCircleIcon />,
  warning: <AlertTriangleIcon />,
  danger: <XCircleIcon />,
  info: <InfoIcon />,
  neutral: <DotIcon />,
};

export interface StatusBadgeProps {
  /** Visual tone. Chosen by the caller from the internal status enum. */
  tone: StatusTone;
  /** Already-translated status text. Always rendered: status is never colour-only (§24.3). */
  label: string;
  className?: string;
}

/** Status pill with a tone-specific icon AND a text label, so colour is never the only signal. */
export function StatusBadge({ tone, label, className }: StatusBadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
    >
      {toneIcons[tone]}
      <span>{label}</span>
    </span>
  );
}
