"use client";

import { cancelBookingAction } from "@/app/actions/bookings";
import { t } from "@/lib/labels";
import { ConfirmButton } from "./ConfirmButton";

/**
 * Cancelling a booking ends a commitment the other side is relying on, so it
 * asks first. It used to fire on a single click with nothing to undo.
 */
export function CancelBookingButton({ bookingId }: { bookingId: string }) {
  return (
    <ConfirmButton
      label={t("dash.cancel")}
      question={t("booking.cancelConfirm")}
      confirmLabel={t("booking.cancelConfirmAction")}
      onConfirm={() => cancelBookingAction(bookingId)}
    />
  );
}
