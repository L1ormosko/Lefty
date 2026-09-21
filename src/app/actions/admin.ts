"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireRole } from "@/server/auth";
import { toUserMessage } from "@/server/errors";
import { notify } from "@/server/notifications";
import { recordAudit } from "@/server/audit";
import { t } from "@/lib/labels";
import { isUsableQuad, parseQuad } from "@/lib/mockup";
import { rateLimit } from "@/server/rate-limit";
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
 * Change what somebody is.
 *
 * This did not exist, and its absence had a sharp edge: appointing an admin
 * required a hand-written UPDATE against the database, and the production
 * database accepts no external connections. Whoever the seed happened to
 * create was the only admin there would ever be.
 *
 * Three guards, and the last two are what stop this locking everyone out:
 *
 *   1. Never your own role. Nobody demotes themselves by accident, and it
 *      closes the "promote myself" path for a compromised non-admin session -
 *      though only an admin gets this far at all.
 *   2. Never the last active admin. A platform with no admin cannot verify a
 *      listing, record a payment or read this log, and there is no way back in
 *      through the interface.
 *   3. Audited, always. Appointing an admin is the most consequential thing
 *      one account can do to another.
 */
export async function setUserRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const admin = await requireRole("ADMIN");
    const userId = String(formData.get("userId") ?? "");
    const role = String(formData.get("role") ?? "");
    if (role !== "ADVERTISER" && role !== "MEDIA_OWNER" && role !== "ADMIN") {
      return { ok: false, error: "תפקיד לא תקין." };
    }
    if (admin.id === userId) return { ok: false, error: t("admin.roleSelfRefused") };

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true },
    });
    if (!target) return { ok: false, error: "המשתמש לא נמצא." };
    if (target.role === role) return { ok: true, message: t("admin.roleSaved") };

    // Counted at the moment of the change rather than trusted from a cached
    // number: two admins demoting each other at once would otherwise both pass
    // a check made a second earlier.
    if (target.role === "ADMIN") {
      const remaining = await prisma.user.count({
        where: { role: "ADMIN", isActive: true, id: { not: userId } },
      });
      if (remaining === 0) return { ok: false, error: t("admin.roleLastAdminRefused") };
    }

    await prisma.user.update({ where: { id: userId }, data: { role } });

    await recordAudit({
      actorId: admin.id,
      action: "USER_ROLE_CHANGED",
      targetType: "User",
      targetId: userId,
      summary: `${target.email}: ${target.role} → ${role}`,
    });

    revalidatePath("/admin/users");
    return { ok: true, message: t("admin.roleSaved") };
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
        data: {
          surfaceQuad: Prisma.DbNull,
          // The provenance goes with the quad it described. Leaving "ai"
          // behind on a cleared row would leave a confidence attached to
          // nothing, and would let detection treat the photo as already
          // answered when an admin has just said it has no usable face.
          surfaceSource: null,
          surfaceConfidence: null,
          // Kept: an admin clearing a face IS the check, and re-running
          // detection on a photo a person just rejected would undo them.
          surfaceCheckedAt: new Date(),
        },
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
      data: {
        surfaceQuad: quad,
        // A person looked at the photograph and placed these corners. That
        // outranks any detection: "admin" is shown unconditionally, and
        // detectAndStore refuses to touch a row carrying it, so a correction
        // made here cannot be reverted by a later run.
        surfaceSource: "admin",
        // There is no confidence in a human's marking, and a number left over
        // from the detection this replaces would describe the wrong quad.
        surfaceConfidence: null,
        surfaceCheckedAt: new Date(),
      },
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

/**
 * Run face detection over photographs nobody has looked at yet.
 *
 * This exists as a button rather than as the one-off script the other
 * backfills in prisma/ are, and the reason is not preference. The production
 * database accepts no external connections - its IP allow list is empty - so
 * a script run from a laptop cannot reach the rows that need backfilling. It
 * would be a tool that works everywhere except the one place it is for, which
 * is the definition of the fake feature this project refuses to ship.
 *
 * Batched, and small. Each photo is a call to a vision model with a
 * twenty-second ceiling; a press that tried to clear a thousand of them would
 * be a request that times out somewhere between here and the browser, having
 * done an unknown amount of work. A press does ten, says how many are left,
 * and can be pressed again.
 */
const DETECT_BATCH = 10;

export async function detectMissingSurfacesAction(): Promise<ActionState> {
  try {
    const admin = await requireRole("ADMIN");

    const { detectAndStore, detectionEnabled } = await import("@/server/surface");
    if (!detectionEnabled()) return { ok: false, error: t("mockup.detectOff") };

    const limited = rateLimit(`surface:detect:${admin.id}`, 20, 60 * 60_000);
    if (!limited.ok) return { ok: false, error: t("mockup.detectTooMany") };

    /*
     * Before detecting, give listings a photograph to detect on.
     *
     * A listing whose owner uploaded nothing had no preview at all, and no
     * amount of detection changes that - there was no picture. A Street View
     * row is a description of a view, not bytes, so this is cheap and stores
     * nothing of Google's; the frame is fetched when someone looks at it.
     *
     * Only ACTIVE listings: a draft nobody has published does not need a
     * photograph from anywhere, and asking Google about it spends a request
     * on a listing that may never exist.
     */
    const { ensureStreetViewPhoto } = await import("@/server/streetview");
    const needPhoto = await prisma.mediaAsset.findMany({
      where: { status: "ACTIVE", images: { none: { storageProvider: "streetview" } } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: DETECT_BATCH,
    });
    let attached = 0;
    for (const asset of needPhoto) {
      if (await ensureStreetViewPhoto(asset.id)) attached++;
    }

    // Never looked at, and no face already on it. A photo an admin marked by
    // hand has a quad and a source, and is not a candidate for anything.
    const where = { surfaceCheckedAt: null, surfaceSource: null };
    const pending = await prisma.mediaAssetImage.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: DETECT_BATCH,
    });
    if (pending.length === 0) {
      revalidatePath("/admin/assets");
      return {
        ok: true,
        message: attached
          ? t("mockup.detectAttached", { attached: `⁨${attached}⁩` })
          : t("mockup.detectNone"),
      };
    }

    let found = 0;
    for (const image of pending) {
      // Sequential on purpose: ten concurrent vision calls from a single
      // free-tier instance is how a page becomes unresponsive for everybody
      // else using the site at that moment.
      const outcome = await detectAndStore(image.id);
      if (outcome.status === "found") found++;
    }

    const remaining = await prisma.mediaAssetImage.count({ where });
    await recordAudit({
      actorId: admin.id,
      action: "ASSET_SURFACE_MARKED",
      targetType: "MediaAssetImage",
      targetId: pending[0].id,
      summary: `זיהוי אוטומטי · ${pending.length} תמונות · ${found} פאות`,
    });
    revalidatePath("/admin/assets");
    return {
      ok: true,
      message:
        t("mockup.detectDone", {
          checked: `⁨${pending.length}⁩`,
          found: `⁨${found}⁩`,
          left: `⁨${remaining}⁩`,
        }) + (attached ? " " + t("mockup.detectAttached", { attached: `⁨${attached}⁩` }) : ""),
    };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}
