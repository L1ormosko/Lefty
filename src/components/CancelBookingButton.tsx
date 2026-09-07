"use client";

import { useState, useTransition } from "react";
import { cancelBookingAction } from "@/app/actions/bookings";
import { t } from "@/lib/labels";
import { Button } from "./ui";

export function CancelBookingButton({ bookingId }: { bookingId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await cancelBookingAction(bookingId);
            if (res && !res.ok) setError(res.error ?? t("common.error"));
          })
        }
      >
        {pending ? t("common.loading") : t("dash.cancel")}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-bad-700 mt-1">
          {error}
        </p>
      )}
    </div>
  );
}
