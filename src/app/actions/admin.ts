"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireRole } from "@/server/auth";
import { toUserMessage } from "@/server/errors";
import { notify } from "@/server/notifications";
import { recordAudit } from "@/server/audit";
import { t } from "@/lib/labels";
import { isUsableQuad, parseQuad } from "@/lib/mockup";
import { Prisma } from "@prisma/client";
import type { ActionState } from "./inquiries";

/** Admin verification decision. Reasons are stored, not just a flag. */
export async function verifyAssetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const admin = await requireRole("ADMIN");
    const assetId = String(formData.get("assetId") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const reviewNote = String(formData.get("reviewNote") ?? "").slice(0, 1000);
    if (decision !== "VERIFIED" && decision !== "REJECTED") {
      return { ok: false, error: "החלטה לא תקינה." };
    }

    const asset = await prisma.mediaAsset.findUnique({
      where: { id: assetId },
      select: { id: true, title: true, ownerId: true },
    });
    if (!asset) return { ok: false, error: "השטח לא נמצא." };

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        verificationStatus: decision,
        verifiedAt: decision === "VERIFIED" ? new Date() : null,
        verifiedById: decision === "VERIFIED" ? admin.id : null,
        reviewNote: reviewNote || null,
        // A rejected asset must not stay publicly listed.
        status: decision === "REJECTED" ? "INACTIVE" : undefined,
      },
    });

    await notify({
      userId: asset.ownerId,
      type: decision === "VERIFIED" ? "ASSET_VERIFIED" : "ASSET_REJECTED",
      title:
        decision === "VERIFIED"
          ? `${t("verify.VERIFIED")}: ${asset.title}`
          : `${t("verify.REJECTED")}: ${asset.title}`,
      body: reviewNote || undefined,
      linkUrl: "/owner/assets",
    });

    await recordAudit({
      actorId: admin.id,
      action: decision === "VERIFIED" ? "ASSET_VERIFIED" : "ASSET_REJECTED",
      targetType: "MediaAsset",
      targetId: asset.id,
      summary: reviewNote ? `${asset.title} — ${reviewNote}` : asset.title,
    });

    revalidatePath("/admin/assets");
    revalidatePath("/explore");
    revalidatePath("/");
    return { ok: true, message: t(`verify.${decision}`) };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function setAssetStatusAdminAction(assetId: string, status: "ACTIVE" | "INACTIVE"): Promise<ActionState> {
  try {
    const admin = await requireRole("ADMIN");
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: assetId },
      select: { id: true, title: true },
    });
    if (!asset) return { ok: false, error: "השטח לא נמצא." };
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status } });
    await recordAudit({
      actorId: admin.id,
      action: status === "ACTIVE" ? "ASSET_PUBLISHED" : "ASSET_UNPUBLISHED",
      targetType: "MediaAsset",
      targetId: asset.id,
      summary: asset.title,
    });
    revalidatePath("/admin/assets");
    revalidatePath("/explore");
    revalidatePath("/");
    return { ok: true, message: t(`status.${status}`) };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

/** Deactivating a user also kills their sessions. */
export async function setUserActiveAction(userId: string, isActive: boolean): Promise<ActionState> {
  try {
    const admin = await requireRole("ADMIN");
    if (admin.id === userId) return { ok: false, error: "לא ניתן להשבית את המשתמש שלכם." };
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!target) return { ok: false, error: "המשתמש לא נמצא." };
    await prisma.user.update({ where: { id: userId }, data: { isActive } });
    if (!isActive) await prisma.session.deleteMany({ where: { userId } });
    await recordAudit({
      actorId: admin.id,
      action: isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED",
      targetType: "User",
      targetId: userId,
      summary: target.email,
    });
    revalidatePath("/admin/users");
    return { ok: true, message: isActive ? t("admin.activate") : t("admin.deactivate") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

/**
 * Record or change a media owner's subscription.
 *
 * Recording, not charging: VELTO issues no invoices and moves no money. An
 * Israeli tax invoice has to come out of approved bookkeeping software, so
 * `invoiceRef` points at a document that exists somewhere else.
 */
export async function setOwnerPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const admin = await requireRole("ADMIN");
    const userId = String(formData.get("userId") ?? "");
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, email: true },
    });
    if (!user) return { ok: false, error: "המשתמש לא נמצא." };
    // Both sides of the marketplace pay. This used to refuse anything but a
    // media owner, which left no way at all to record that an advertiser had
    // paid - and an advertiser whose trial ends with no recorded payment
    // simply loses the inventory. The revenue model had no operating handle.
    if (user.role === "ADMIN") {
      return { ok: false, error: "למנהלים יש גישה מלאה ממילא." };
    }

    const isOwner = user.role === "MEDIA_OWNER";

    // An empty limit means "no cap on published listings", which is what every
    // advertiser is and what an owner on an unmetered deal is.
    //
    // It used to delete the whole Subscription row. That was safe when the row
    // held nothing but a listing limit, and became destructive the moment the
    // same row started carrying trialEndsAt and paidThrough: an admin clearing
    // a quota would silently revoke the customer's access to the inventory.
    const rawLimit = String(formData.get("activeListingLimit") ?? "").trim();
    let limit: number | null = null;
    if (rawLimit !== "") {
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 0) {
        return { ok: false, error: "מכסת שטחים חייבת להיות מספר שלם." };
      }
      if (!isOwner) {
        return { ok: false, error: "מכסת שטחים רלוונטית לבעלי שטחים בלבד." };
      }
      limit = parsedLimit;
    }

    const paidThrough = endOfDay(String(formData.get("paidThrough") ?? "").trim());
    if (paidThrough === "invalid") return { ok: false, error: "תאריך לא תקין." };
    const committedUntil = endOfDay(String(formData.get("committedUntil") ?? "").trim());
    if (committedUntil === "invalid") return { ok: false, error: "תאריך לא תקין." };

    const rawAmount = String(formData.get("monthlyAmount") ?? "").trim();
    let monthlyAmount: number | null = null;
    if (rawAmount !== "") {
      const amount = Number(rawAmount);
      if (!Number.isInteger(amount) || amount < 0) {
        return { ok: false, error: "סכום חודשי חייב להיות מספר שלם." };
      }
      monthlyAmount = amount;
    }

    const invoiceRef = String(formData.get("invoiceRef") ?? "").trim().slice(0, 120) || null;
    const note = String(formData.get("note") ?? "").trim().slice(0, 500) || null;

    const data = { activeListingLimit: limit, paidThrough, committedUntil, monthlyAmount, invoiceRef, note };
    await prisma.subscription.upsert({
      where: { userId },
      create: { userId, ...data },
      // trialEndsAt is deliberately untouched: it is a record of what the
      // account was given at registration, not a lever.
      update: data,
    });

    await recordAudit({
      actorId: admin.id,
      action: "SUBSCRIPTION_CHANGED",
      targetType: "User",
      targetId: user.id,
      summary: `${user.email} · מכסה ${limit ?? "ללא הגבלה"} · בתוקף עד ${
        paidThrough ? paidThrough.toISOString().slice(0, 10) : "לא צוין"
      }`,
    });

    revalidatePath("/admin/users");
    revalidatePath("/owner/assets");
    revalidatePath("/explore");
    // Says what happened, not what was pressed. Clearing the quota used to
    // report "subscription cancelled" while also deleting the row that held
    // the customer's access - the message was accurate about a behaviour that
    // should never have existed.
    return { ok: true, message: limit === null && isOwner ? t("plan.limitCleared") : t("plan.saved") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

/**
 * A yyyy-mm-dd form field as an instant, at the very end of that day.
 *
 * "Paid through the 30th" has to include the 30th: storing midnight would cut
 * a customer off a day early, on the day they paid for.
 */
function endOfDay(raw: string): Date | null | "invalid" {
  if (!raw) return null;
  const date = new Date(`${raw}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

/**
 * Mark (or clear) the face of the sign in one photo.
 *
 * Admin-only on purpose. The quad decides where an advertiser's artwork lands
 * in a preview they may well show a client, and a sloppy one produces a
 * picture that misrepresents the site - the same class of harm as a wrong
 * price. An owner marking their own is a later decision, with review attached.
 */
export async function setImageQuadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const admin = await requireRole("ADMIN");
    const imageId = String(formData.get("imageId") ?? "");
    const image = await prisma.mediaAssetImage.findUnique({
      where: { id: imageId },
      select: { id: true, assetId: true },
    });
    if (!image) return { ok: false, error: "התמונה לא נמצאה." };

    const raw = String(formData.get("quad") ?? "").trim();
    if (!raw) {
      await prisma.mediaAssetImage.update({
        where: { id: image.id },
        data: { surfaceQuad: Prisma.DbNull },
      });
      revalidatePath(`/assets/${image.assetId}`);
      revalidatePath("/admin/assets");
      return { ok: true, message: t("mockup.cleared") };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: t("mockup.invalid") };
    }

    const quad = parseQuad(parsed);
    // Both checks matter and they catch different mistakes: parseQuad rejects
    // values that are not four points, isUsableQuad rejects four points that
    // do not enclose a face - a mis-click, or corners clicked out of order,
    // which renders artwork folded through itself.
    if (!quad || !isUsableQuad(quad)) return { ok: false, error: t("mockup.invalid") };

    await prisma.mediaAssetImage.update({
      where: { id: image.id },
      data: { surfaceQuad: quad },
    });
    await recordAudit({
      actorId: admin.id,
      action: "ASSET_SURFACE_MARKED",
      targetType: "MediaAssetImage",
      targetId: image.id,
      summary: "פאה סומנה",
    });
    revalidatePath(`/assets/${image.assetId}`);
    revalidatePath("/admin/assets");
    return { ok: true, message: t("mockup.saved") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

/**
 * Where a photo was taken from, relative to the sign's face.
 *
 * Deliberately three coarse choices and "not stated" rather than a number
 * field: an owner standing in a street knows which side they were on and does
 * not know they were at 23 degrees, and a typed figure would dress that guess
 * up as a measurement. The value only orders the angles and labels them.
 */
export async function setImageAngleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    await requireRole("ADMIN");
    const imageId = String(formData.get("imageId") ?? "");
    const image = await prisma.mediaAssetImage.findUnique({
      where: { id: imageId },
      select: { id: true, assetId: true },
    });
    if (!image) return { ok: false, error: "התמונה לא נמצאה." };

    const raw = String(formData.get("angle") ?? "").trim();
    const choices: Record<string, number> = { left: -30, front: 0, right: 30 };
    // Anything unrecognised - including the empty "not stated" choice - clears
    // the angle rather than being coerced to zero, which would claim the photo
    // was taken head on.
    const angle = raw in choices ? choices[raw] : null;

    await prisma.mediaAssetImage.update({
      where: { id: image.id },
      data: { viewAngleDeg: angle },
    });
    revalidatePath(`/assets/${image.assetId}`);
    revalidatePath("/admin/assets");
    return { ok: true, message: t("mockup.angleSaved") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}
