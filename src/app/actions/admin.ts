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
