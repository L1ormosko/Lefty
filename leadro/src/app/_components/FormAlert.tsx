import { AlertTriangleIcon, CheckCircleIcon, InfoIcon, cx } from "@/components/ui";

type AlertTone = "danger" | "success" | "info";

const toneClasses: Record<AlertTone, string> = {
  danger: "border-danger-line bg-danger-soft text-danger",
  success: "border-success-line bg-success-soft text-success",
  info: "border-info-line bg-info-soft text-info",
};

const toneIcons = { danger: AlertTriangleIcon, success: CheckCircleIcon, info: InfoIcon } as const;

/** Form-level message. Errors use `role="alert"` so screen readers announce them immediately. */
export function FormAlert({ tone, children }: { tone: AlertTone; children: string }) {
  const Icon = toneIcons[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("flex items-start gap-2 rounded border px-3 py-2 text-sm", toneClasses[tone])}
    >
      <Icon className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
