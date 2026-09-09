"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth";
import { loadOwnInquiry } from "@/server/authz";
import { inquirySchema, inquiryMessageSchema, fieldErrors } from "@/lib/validation";
import { toUserMessage, ValidationError } from "@/server/errors";
import { createBookingRequest, validateRequestWindow } from "@/server/bookings";
import { postInquiryMessage } from "@/server/inquiries";
import { notify } from "@/server/notifications";
import { toUtcDate } from "@/lib/dates";
import { rateLimit } from "@/server/rate-limit";
import { t } from "@/lib/labels";

export type ActionState =
  | { ok: true; message: string }
  | { ok: false; error?: string; fields?: Record<string, string> }
  | undefined;

/**
 * Advertiser → media owner. Creates an Inquiry, and for BOOKING intent also a
 * booking request so the owner has something to approve.
 */
export async function createInquiryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: t("auth.loginRequired") };
  }

  const parsed = inquirySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
  const data = parsed.data;

  if (!rateLimit(`inquiry:${user.id}`, 30, 60 * 60_000).ok) {
    return { ok: false, error: t("auth.tooManyAttempts") };
  }

  try {
    const start = toUtcDate(data.startDate);
    const end = toUtcDate(data.endDate);
    const { asset } = await validateRequestWindow(data.assetId, start, end);

    const full = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: asset.id },
      select: { id: true, title: true, ownerId: true, instantBookable: true },
    });
    if (full.ownerId === user.id) {
      throw new ValidationError("לא ניתן לשלוח בקשה לשטח שבבעלותכם.");
    }

    const inquiry = await prisma.inquiry.create({
      data: {
        assetId: data.assetId,
        advertiserId: user.id,
        intent: data.intent,
        startDate: start,
        endDate: end,
        campaignName: data.campaignName,
        budget: typeof data.budget === "number" ? data.budget : null,
        message: data.message || null,
        contactName: data.contactName,
        contactEmail: data.contactEmail,
        contactPhone: data.contactPhone || null,
      },
    });

    if (data.intent === "BOOKING") {
      await createBookingRequest({
        assetId: data.assetId,
        advertiserId: user.id,
        inquiryId: inquiry.id,
        startDate: start,
        endDate: end,
      });
    }

    await notify({
      userId: full.ownerId,
      type: "INQUIRY_CREATED",
      title: `פנייה חדשה: ${full.title}`,
      body: `${data.campaignName} · ${data.startDate} – ${data.endDate}`,
      linkUrl: "/owner/inquiries",
    });

    revalidatePath("/dashboard/requests");
    return { ok: true, message: t("request.submitted") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

/** Media owner responds to an inquiry. */
/**
 * Add a message to an inquiry. Either side may write - the whole point of the
 * thread is that the conversation can continue past one answer.
 */
export async function postInquiryMessageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const parsed = inquiryMessageSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };

    const { inquiry } = await loadOwnInquiry(parsed.data.inquiryId, user);
    await postInquiryMessage({ inquiryId: inquiry.id, authorId: user.id, body: parsed.data.body });

    revalidatePath(`/owner/inquiries/${inquiry.id}`);
    revalidatePath(`/dashboard/requests/${inquiry.id}`);
    revalidatePath("/owner/inquiries");
    revalidatePath("/dashboard/requests");
    return { ok: true, message: t("dash.responseSent") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function closeInquiryAction(inquiryId: string): Promise<ActionState> {
  try {
    const user = await requireUser();
    const { inquiry } = await loadOwnInquiry(inquiryId, user);
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { status: "CLOSED" } });
    revalidatePath("/owner/inquiries");
    revalidatePath("/dashboard/requests");
    return { ok: true, message: t("inquiry.CLOSED") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}
