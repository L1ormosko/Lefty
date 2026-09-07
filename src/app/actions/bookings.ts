"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { loadOwnBooking } from "@/server/authz";
import { bookingDecisionSchema, fieldErrors } from "@/lib/validation";
import { cancelBooking, decideBooking } from "@/server/bookings";
import { toUserMessage } from "@/server/errors";
import { t } from "@/lib/labels";
import type { ActionState } from "./inquiries";

/** Media owner (or admin) approves or rejects a booking request. */
export async function decideBookingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const parsed = bookingDecisionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };

    const { isOwner } = await loadOwnBooking(parsed.data.bookingId, user);
    if (!isOwner && user.role !== "ADMIN") {
      return { ok: false, error: "רק בעל השטח יכול לאשר או לדחות הזמנה." };
    }

    await decideBooking({
      bookingId: parsed.data.bookingId,
      decision: parsed.data.decision,
      ownerNote: parsed.data.ownerNote || undefined,
    });

    revalidatePath("/owner/bookings");
    revalidatePath("/dashboard/bookings");
    return {
      ok: true,
      message: parsed.data.decision === "APPROVED" ? t("booking.APPROVED") : t("booking.REJECTED"),
    };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function cancelBookingAction(bookingId: string): Promise<ActionState> {
  try {
    const user = await requireUser();
    await loadOwnBooking(bookingId, user);
    await cancelBooking(bookingId, user.id);
    revalidatePath("/owner/bookings");
    revalidatePath("/dashboard/bookings");
    return { ok: true, message: t("booking.CANCELLED") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}
