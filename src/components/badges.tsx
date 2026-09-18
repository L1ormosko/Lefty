/**
 * Status badges. Every badge carries colour AND text AND a glyph, so the state
 * is readable without colour perception (and in a screenshot, and in print).
 *
 * One rule decides how loud a badge is:
 *
 *   **A border is for a state that wants attention. The expected state is
 *   quiet.**
 *
 * Before this rule, a result card carried three bordered pills and every one
 * of them was the ordinary case - available, pending verification, demo data.
 * A marker that appears on all sixteen cards distinguishes nothing; it only
 * adds weight. So the ordinary states render as `quiet`: the same glyph and
 * the same words, in the same semantic colour, with no box drawn round them.
 * "Booked" and "rejected" keep the box, because those are the ones a reader
 * needs to catch.
 *
 * Nothing is removed - the text and the title tooltip are identical either
 * way, so a screen reader hears the same thing and colour is still never the
 * only channel.
 */
import type { AvailabilityState } from "@/lib/constants";
import { AVAILABILITY_GLYPH, t } from "@/lib/labels";
import { cx } from "./ui";

/** Bordered: the state is an exception. */
const AVAILABILITY_LOUD: Record<AvailabilityState, string> = {
  AVAILABLE: "bg-ok-50 text-ok-700 border-ok-200",
  PARTIAL: "bg-warn-50 text-warn-700 border-warn-200",
  OCCUPIED: "bg-bad-50 text-bad-700 border-bad-200",
  INACTIVE: "bg-ink-100 text-ink-600 border-ink-300",
  PENDING_VERIFICATION: "bg-ink-100 text-ink-700 border-ink-300",
};

/** Unbordered: the state is the norm, and the colour alone carries it. */
const AVAILABILITY_QUIET: Record<AvailabilityState, string> = {
  AVAILABLE: "text-ok-700",
  PARTIAL: "text-warn-700",
  OCCUPIED: "text-bad-700",
  INACTIVE: "text-ink-500",
  PENDING_VERIFICATION: "text-ink-500",
};

/**
 * Which states are worth a box by default.
 *
 * Availability is the one thing on a card that changes the answer, so the two
 * that mean "you may not get these dates" stay loud and the rest go quiet.
 */
const LOUD_BY_DEFAULT: AvailabilityState[] = ["OCCUPIED", "INACTIVE"];

export function AvailabilityBadge({
  state,
  size = "md",
  note,
  tone,
}: {
  state: AvailabilityState;
  size?: "sm" | "md";
  note?: string;
  /** Override the default loudness - the filter panel wants every row loud. */
  tone?: "quiet" | "loud";
}) {
  const loud = tone ? tone === "loud" : LOUD_BY_DEFAULT.includes(state);
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 font-medium",
        loud
          ? cx("rounded border", AVAILABILITY_LOUD[state], size === "sm" ? "px-1.5 py-0.5" : "px-2 py-1")
          : AVAILABILITY_QUIET[state],
        size === "sm" ? "text-[11px]" : "text-xs"
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
  tone,
}: {
  status: "PENDING" | "VERIFIED" | "REJECTED";
  size?: "sm" | "md";
  tone?: "quiet" | "loud";
}) {
  const loud = tone ? tone === "loud" : status === "REJECTED";
  const styles = {
    VERIFIED: "bg-brand-50 text-brand-700 border-brand-200",
    PENDING: "bg-ink-100 text-ink-700 border-ink-300",
    REJECTED: "bg-bad-50 text-bad-700 border-bad-200",
  } as const;
  const quiet = {
    VERIFIED: "text-brand-700",
    PENDING: "text-ink-500",
    REJECTED: "text-bad-700",
  } as const;
  const glyph = { VERIFIED: "✓", PENDING: "◷", REJECTED: "✕" } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 font-medium",
        loud
          ? cx("rounded border", styles[status], size === "sm" ? "px-1.5 py-0.5" : "px-2 py-1")
          : quiet[status],
        size === "sm" ? "text-[11px]" : "text-xs"
      )}
      title={t(`verify.${status}.help`)}
    >
      <span aria-hidden="true">{glyph[status]}</span>
      <span>{t(`verify.${status}`)}</span>
    </span>
  );
}

/**
 * Seeded demo inventory, marked as such.
 *
 * The product rule is that demo data must always be identifiable, and it still
 * is - but identifying it once per list is what actually communicates. When
 * every card in a list carries this pill, the pill has stopped saying "this
 * one is demo" and started being wallpaper. Lists say it on a line of their
 * own above the results (see DemoNotice); this badge is for the places where a
 * single demo row sits among real ones - the owner's and the admin's tables.
 */
export function DemoBadge({ tone = "quiet" }: { tone?: "quiet" | "loud" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center text-[11px] font-medium text-ink-500",
        tone === "loud" && "rounded border border-ink-300 bg-white px-1.5 py-0.5 text-ink-600"
      )}
      title={t("common.demoDataNote")}
    >
      {t("common.demoData")}
    </span>
  );
}

/**
 * The same statement, once, for a list that is entirely or partly seeded.
 *
 * One line at the top beats a pill on every row: it is read, rather than
 * skipped over sixteen times, and it leaves the rows themselves free to show
 * what actually differs between them.
 */
export function DemoNotice({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <p className={cx("text-xs text-ink-500", className)}>
      {t("common.demoData")} · {t("common.demoDataNote")}
    </p>
  );
}

export function StatusPill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "ok" | "warn" | "bad" }) {
  const styles = {
    neutral: "bg-ink-100 text-ink-700 border-ink-300",
    ok: "bg-ok-50 text-ok-700 border-ok-200",
    warn: "bg-warn-50 text-warn-700 border-warn-200",
    bad: "bg-bad-50 text-bad-700 border-bad-200",
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
