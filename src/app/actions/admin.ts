"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireRole } from "@/server/auth";
import { toUserMessage } from "@/server/errors";
import { notify } from "@/server/notifications";
import { t } from "@/lib/labels";
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
    await requireRole("ADMIN");
    await prisma.mediaAsset.update({ where: { id: assetId }, data: { status } });
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
    await prisma.user.update({ where: { id: userId }, data: { isActive } });
    if (!isActive) await prisma.session.deleteMany({ where: { userId } });
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
    await requireRole("ADMIN");
    const userId = String(formData.get("userId") ?? "");
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) return { ok: false, error: "המשתמש לא נמצא." };
    if (user.role !== "MEDIA_OWNER") {
      return { ok: false, error: "מנוי רלוונטי לבעלי שטחים בלבד." };
    }

    // An empty limit is how a plan is removed - see below. Anything else has
    // to be a real, non-negative count.
    const rawLimit = String(formData.get("activeListingLimit") ?? "").trim();
    if (rawLimit === "") {
      await prisma.ownerPlan.deleteMany({ where: { userId } });
      revalidatePath("/admin/users");
      revalidatePath("/owner/assets");
      return { ok: true, message: t("plan.removed") };
    }

    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 0) {
      return { ok: false, error: "מכסת שטחים חייבת להיות מספר שלם." };
    }

    const rawPaidThrough = String(formData.get("paidThrough") ?? "").trim();
    // Stored at the end of the day: a subscription paid "through the 30th"
    // lapses on the 31st, not at midnight on the 30th.
    const paidThrough = rawPaidThrough ? new Date(`${rawPaidThrough}T23:59:59.999Z`) : null;
    if (paidThrough && Number.isNaN(paidThrough.getTime())) {
      return { ok: false, error: "תאריך לא תקין." };
    }

    const invoiceRef = String(formData.get("invoiceRef") ?? "").trim().slice(0, 120) || null;
    const note = String(formData.get("note") ?? "").trim().slice(0, 500) || null;

    await prisma.ownerPlan.upsert({
      where: { userId },
      create: { userId, activeListingLimit: limit, paidThrough, invoiceRef, note },
      update: { activeListingLimit: limit, paidThrough, invoiceRef, note },
    });

    revalidatePath("/admin/users");
    revalidatePath("/owner/assets");
    return { ok: true, message: t("plan.saved") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}
