"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireRole, requireUser } from "@/server/auth";
import { loadOwnedAsset } from "@/server/authz";
import {
  assetBasicSchema,
  assetLocationSchema,
  assetPricingSchema,
  assetSpecsSchema,
  availabilityPeriodSchema,
  fieldErrors,
} from "@/lib/validation";
import { toUserMessage, ValidationError } from "@/server/errors";
import { toUtcDate } from "@/lib/dates";
import { t } from "@/lib/labels";
import type { AssetType, Illumination, PermitStatus } from "@prisma/client";

export type AssetActionState =
  | { ok: true; assetId: string; message?: string }
  | { ok: false; error?: string; fields?: Record<string, string> }
  | undefined;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Step 1 of the wizard creates the asset as a DRAFT immediately, so nothing is
 * lost if the owner leaves halfway. Later steps update the same row.
 */
export async function saveAssetBasicsAction(_prev: AssetActionState, formData: FormData): Promise<AssetActionState> {
  try {
    const user = await requireRole("MEDIA_OWNER");
    const parsed = assetBasicSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };

    const assetId = String(formData.get("assetId") ?? "");
    const data = {
      title: parsed.data.title,
      description: parsed.data.description || null,
      assetType: parsed.data.assetType as AssetType,
    };

    if (assetId) {
      const asset = await loadOwnedAsset(assetId, user);
      await prisma.mediaAsset.update({ where: { id: asset.id }, data });
      return { ok: true, assetId: asset.id };
    }

    const created = await prisma.mediaAsset.create({
      data: {
        ...data,
        ownerId: user.id,
        companyId: user.companyId,
        // Placeholder location; step 2 requires a real one before publishing.
        address: "",
        city: "",
        latitude: 31.2518,
        longitude: 34.7913,
        status: "DRAFT",
      },
    });
    revalidatePath("/owner/assets");
    return { ok: true, assetId: created.id };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function saveAssetLocationAction(_prev: AssetActionState, formData: FormData): Promise<AssetActionState> {
  try {
    const user = await requireRole("MEDIA_OWNER");
    const parsed = assetLocationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
    const asset = await loadOwnedAsset(String(formData.get("assetId")), user);

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        address: parsed.data.address,
        city: parsed.data.city,
        region: parsed.data.region || null,
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
      },
    });
    return { ok: true, assetId: asset.id };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function saveAssetSpecsAction(_prev: AssetActionState, formData: FormData): Promise<AssetActionState> {
  try {
    const user = await requireRole("MEDIA_OWNER");
    const raw = Object.fromEntries(formData);
    const parsed = assetSpecsSchema.safeParse({
      ...raw,
      isDigital: raw.isDigital === "on" || raw.isDigital === "true",
    });
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
    const asset = await loadOwnedAsset(String(formData.get("assetId")), user);

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        widthCm: num(parsed.data.widthCm),
        heightCm: num(parsed.data.heightCm),
        orientation: parsed.data.orientation || null,
        sides: parsed.data.sides,
        illumination: parsed.data.illumination as Illumination,
        isDigital: parsed.data.isDigital,
        permitStatus: parsed.data.permitStatus as PermitStatus,
      },
    });
    return { ok: true, assetId: asset.id };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function saveAssetPricingAction(_prev: AssetActionState, formData: FormData): Promise<AssetActionState> {
  try {
    const user = await requireRole("MEDIA_OWNER");
    const raw = Object.fromEntries(formData);
    const parsed = assetPricingSchema.safeParse({
      ...raw,
      productionIncluded: raw.productionIncluded === "on",
      installationIncluded: raw.installationIncluded === "on",
      removalIncluded: raw.removalIncluded === "on",
      instantBookable: raw.instantBookable === "on",
    });
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
    const asset = await loadOwnedAsset(String(formData.get("assetId")), user);

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        priceWeekly: num(parsed.data.priceWeekly),
        priceMonthly: num(parsed.data.priceMonthly),
        minimumBookingDays: parsed.data.minimumBookingDays,
        productionIncluded: parsed.data.productionIncluded,
        installationIncluded: parsed.data.installationIncluded,
        removalIncluded: parsed.data.removalIncluded,
        instantBookable: parsed.data.instantBookable,
      },
    });
    return { ok: true, assetId: asset.id };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function addAvailabilityPeriodAction(
  _prev: AssetActionState,
  formData: FormData
): Promise<AssetActionState> {
  try {
    const user = await requireRole("MEDIA_OWNER");
    const parsed = availabilityPeriodSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
    const asset = await loadOwnedAsset(String(formData.get("assetId")), user);

    await prisma.availabilityPeriod.create({
      data: {
        assetId: asset.id,
        startDate: toUtcDate(parsed.data.startDate),
        endDate: toUtcDate(parsed.data.endDate),
        note: parsed.data.note || null,
      },
    });
    revalidatePath(`/owner/assets/${asset.id}`);
    return { ok: true, assetId: asset.id };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function deleteAvailabilityPeriodAction(periodId: string): Promise<AssetActionState> {
  try {
    const user = await requireRole("MEDIA_OWNER");
    const period = await prisma.availabilityPeriod.findUnique({
      where: { id: periodId },
      select: { id: true, assetId: true },
    });
    if (!period) return { ok: false, error: "החלון לא נמצא." };
    const asset = await loadOwnedAsset(period.assetId, user);
    await prisma.availabilityPeriod.delete({ where: { id: period.id } });
    revalidatePath(`/owner/assets/${asset.id}`);
    return { ok: true, assetId: asset.id };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

/** Publish: the asset becomes public and enters the admin verification queue. */
export async function publishAssetAction(_prev: AssetActionState, formData: FormData): Promise<AssetActionState> {
  try {
    const user = await requireRole("MEDIA_OWNER");
    const asset = await loadOwnedAsset(String(formData.get("assetId")), user);

    const missing: string[] = [];
    if (!asset.title) missing.push(t("wizard.basic"));
    if (!asset.address || !asset.city) missing.push(t("wizard.location"));
    if (missing.length) {
      throw new ValidationError(`חסרים פרטים לפני פרסום: ${missing.join(", ")}`);
    }

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: "ACTIVE", verificationStatus: asset.verifiedAt ? asset.verificationStatus : "PENDING" },
    });
    revalidatePath("/owner/assets");
    revalidatePath("/");
    return { ok: true, assetId: asset.id, message: t("wizard.published") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function setAssetStatusAction(assetId: string, status: "ACTIVE" | "INACTIVE"): Promise<AssetActionState> {
  try {
    const user = await requireUser();
    const asset = await loadOwnedAsset(assetId, user);
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status } });
    revalidatePath("/owner/assets");
    revalidatePath("/");
    return { ok: true, assetId: asset.id };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function deleteAssetImageAction(imageId: string): Promise<AssetActionState> {
  try {
    const user = await requireUser();
    const image = await prisma.mediaAssetImage.findUnique({
      where: { id: imageId },
      select: { id: true, assetId: true, isPrimary: true },
    });
    if (!image) return { ok: false, error: "התמונה לא נמצאה." };
    const asset = await loadOwnedAsset(image.assetId, user);
    await prisma.mediaAssetImage.delete({ where: { id: image.id } });
    if (image.isPrimary) {
      const next = await prisma.mediaAssetImage.findFirst({
        where: { assetId: asset.id },
        orderBy: { sortOrder: "asc" },
      });
      if (next) await prisma.mediaAssetImage.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    revalidatePath(`/owner/assets/${asset.id}`);
    return { ok: true, assetId: asset.id };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}
