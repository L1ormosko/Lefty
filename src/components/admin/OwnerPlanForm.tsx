"use client";

import { useActionState, useState } from "react";
import { setOwnerPlanAction } from "@/app/actions/admin";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Button, inputClass } from "@/components/ui";

/**
 * Recording a media owner's subscription, by hand.
 *
 * Collapsed by default. Most rows on this page are not owners, and of the ones
 * that are, most will never have a plan: this is a drawer, not a field.
 */
export function OwnerPlanForm({
  userId,
  limit,
  paidThrough,
  invoiceRef,
}: {
  userId: string;
  limit: number | null;
  /** ISO date (yyyy-mm-dd), already in the shape the date input wants. */
  paidThrough: string | null;
  invoiceRef: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState, FormData>(setOwnerPlanAction, undefined);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {limit == null ? t("plan.none") : t("plan.title")}
      </Button>
    );
  }

  return (
    <form action={action} className="w-full mt-2 pt-3 border-t border-ink-100 space-y-2">
      <input type="hidden" name="userId" value={userId} />
      <p className="text-sm font-medium text-ink-900">{t("plan.adminTitle")}</p>

      <div className="flex flex-wrap gap-2">
        <label className="text-xs text-ink-600">
          {t("plan.limitField")}
          <input
            name="activeListingLimit"
            type="number"
            min={0}
            step={1}
            defaultValue={limit ?? ""}
            className={`${inputClass} mt-1 w-32`}
          />
        </label>
        <label className="text-xs text-ink-600">
          {t("plan.paidThroughField")}
          <input
            name="paidThrough"
            type="date"
            defaultValue={paidThrough ?? ""}
            className={`${inputClass} mt-1 w-44`}
          />
        </label>
        <label className="text-xs text-ink-600">
          {t("plan.invoiceRef")}
          <input
            name="invoiceRef"
            type="text"
            defaultValue={invoiceRef ?? ""}
            className={`${inputClass} mt-1 w-40`}
          />
        </label>
      </div>

      {/* Says what this screen does and, more importantly, what it does not. */}
      <p className="text-xs text-ink-500">
        {t("plan.invoiceNote")} {t("plan.adminNote")}
      </p>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {t("plan.save")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t("common.close")}
        </Button>
        {state?.ok && <span className="text-xs text-ok-700">{state.message}</span>}
        {state && !state.ok && (
          <span role="alert" className="text-xs text-bad-700">
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
