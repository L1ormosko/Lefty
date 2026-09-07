"use client";

import { useActionState } from "react";
import { decideBookingAction } from "@/app/actions/bookings";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Alert, Button, inputClass } from "./ui";

/**
 * Approve / reject a booking request. Approval can legitimately fail when
 * another booking took the dates first - that conflict is shown, not swallowed.
 */
export function BookingDecision({ bookingId }: { bookingId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(decideBookingAction, undefined);

  if (state?.ok) return <Alert kind="success">{state.message}</Alert>;

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="bookingId" value={bookingId} />
      {state?.error && <Alert>{state.error}</Alert>}
      <input
        name="ownerNote"
        className={inputClass}
        placeholder={`${t("dash.respond")} (${t("common.optional")})`}
      />
      <div className="flex gap-2">
        <Button type="submit" name="decision" value="APPROVED" size="sm" disabled={pending}>
          {t("dash.approve")}
        </Button>
        <Button type="submit" name="decision" value="REJECTED" variant="secondary" size="sm" disabled={pending}>
          {t("dash.reject")}
        </Button>
      </div>
    </form>
  );
}
