/**
 * Status badges. Every badge carries colour AND text AND a glyph, so the state
 * is readable without colour perception (and in a screenshot, and in print).
 */
import type { AvailabilityState } from "@/lib/constants";
import { AVAILABILITY_GLYPH, t } from "@/lib/labels";
import { cx } from "./ui";

const AVAILABILITY_CLASS: Record<AvailabilityState, string> = {
  AVAILABLE: "bg-ok-50 text-ok-700 border-ok-500/40",
  PARTIAL: "bg-warn-50 text-warn-700 border-warn-500/40",
  OCCUPIED: "bg-bad-50 text-bad-700 border-bad-500/40",
  INACTIVE: "bg-ink-100 text-ink-600 border-ink-300",
  PENDING_VERIFICATION: "bg-ink-100 text-ink-700 border-ink-300",
};

export function AvailabilityBadge({
  state,
  size = "md",
  note,
}: {
  state: AvailabilityState;
  size?: "sm" | "md";
  note?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded border font-medium",
        AVAILABILITY_CLASS[state],
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs"
      )}
      title={t(`avail.${state}.help`)}
    >
      <span aria-hidden="true">{AVAILABILITY_GLYPH[state]}</span>
      <span>{t(`avail.${state}`)}</span>
      {note && <span className="font-normal opacity-80">{note}</span>}
    </span>
  );
}

export function VerificationBadge({
  status,
  size = "md",
}: {
  status: "PENDING" | "VERIFIED" | "REJECTED";
  size?: "sm" | "md";
}) {
  const styles = {
    VERIFIED: "bg-brand-50 text-brand-700 border-brand-500/40",
    PENDING: "bg-ink-100 text-ink-700 border-ink-300",
    REJECTED: "bg-bad-50 text-bad-700 border-bad-500/40",
  } as const;
  const glyph = { VERIFIED: "✓", PENDING: "◷", REJECTED: "✕" } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded border font-medium",
        styles[status],
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs"
      )}
      title={t(`verify.${status}.help`)}
    >
      <span aria-hidden="true">{glyph[status]}</span>
      <span>{t(`verify.${status}`)}</span>
    </span>
  );
}

export function DemoBadge() {
  return (
    <span
      className="inline-flex items-center rounded border border-ink-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-ink-600"
      title={t("common.demoDataNote")}
    >
      {t("common.demoData")}
    </span>
  );
}

export function StatusPill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "ok" | "warn" | "bad" }) {
  const styles = {
    neutral: "bg-ink-100 text-ink-700 border-ink-300",
    ok: "bg-ok-50 text-ok-700 border-ok-500/40",
    warn: "bg-warn-50 text-warn-700 border-warn-500/40",
    bad: "bg-bad-50 text-bad-700 border-bad-500/40",
  } as const;
  return (
    <span className={cx("inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium", styles[tone])}>
      {label}
    </span>
  );
}

export function bookingTone(status: string): "neutral" | "ok" | "warn" | "bad" {
  if (status === "APPROVED" || status === "COMPLETED") return "ok";
  if (status === "REQUESTED" || status === "PENDING") return "warn";
  if (status === "REJECTED" || status === "CANCELLED") return "bad";
  return "neutral";
}
