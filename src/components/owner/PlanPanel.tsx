import { t } from "@/lib/labels";
import { formatDate } from "@/lib/dates";
import { expiresWithin, type OwnerPlan, type PlanStatus } from "@/lib/plan";
import { Card, Num } from "@/components/ui";

/**
 * The owner's subscription, where they manage listings.
 *
 * Renders nothing without a plan row. That is not laziness: no row means
 * unlimited, and a panel announcing "unlimited" to owners who were never told
 * they might be limited invents a worry the product does not have yet.
 */
/** The stored row, which carries the human-facing invoice reference too. */
type PlanRow = OwnerPlan & { invoiceRef: string | null };

export function PlanPanel({ status, plan }: { status: PlanStatus; plan: PlanRow | null }) {
  if (!plan || status.limit == null) return null;

  const paidThrough = plan.paidThrough;
  const expiring = expiresWithin(plan, 14);
  const tone = status.lapsed
    ? "border-bad-200 bg-bad-50"
    : expiring || status.remaining === 0
      ? "border-warn-200 bg-warn-50"
      : "border-ink-200";

  return (
    <Card className={`p-4 mb-4 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium text-ink-900">{t("plan.title")}</h2>
        <p className="text-sm text-ink-700">
          {t("plan.usage", { used: status.activeCount, limit: status.limit })}
        </p>
      </div>

      <p className="mt-1 text-sm text-ink-600">
        {status.remaining === 0 ? (
          t("plan.full")
        ) : (
          <>{t("plan.remaining", { count: status.remaining ?? 0 })}</>
        )}
      </p>

      {paidThrough && (
        <p className="mt-2 text-sm text-ink-700">
          {status.lapsed
            ? t("plan.lapsed", { date: formatDate(paidThrough) })
            : expiring
              ? t("plan.expiringSoon", { date: formatDate(paidThrough) })
              : t("plan.paidThrough", { date: formatDate(paidThrough) })}
        </p>
      )}

      {/* Said exactly where the owner would otherwise assume the worst. */}
      {(status.lapsed || status.remaining === 0) && (
        <p className="mt-2 text-sm text-ink-800">{t("plan.liveStaySafe")}</p>
      )}

      <p className="mt-3 text-xs text-ink-500">
        {t("plan.invoiceNote")} {t("plan.contact")}
      </p>

      {/* Kept out of the way, but present: an owner reconciling a payment
          should not have to ask us which invoice this was. */}
      {plan.invoiceRef && (
        <p className="mt-1 text-xs text-ink-500">
          {t("plan.invoiceRef")}: <Num>{plan.invoiceRef}</Num>
        </p>
      )}
    </Card>
  );
}
