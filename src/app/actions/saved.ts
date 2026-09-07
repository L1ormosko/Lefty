"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth";
import { toUserMessage } from "@/server/errors";

/** Toggle a saved asset for the signed-in advertiser. Returns the new state. */
export async function toggleSavedAction(assetId: string): Promise<{ saved?: boolean; error?: string }> {
  try {
    const user = await requireUser();
    const existing = await prisma.savedAsset.findUnique({
      where: { userId_assetId: { userId: user.id, assetId } },
      select: { id: true },
    });
    if (existing) {
      await prisma.savedAsset.delete({ where: { id: existing.id } });
      revalidatePath("/dashboard/saved");
      return { saved: false };
    }
    // Only a publicly listed asset can be saved.
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: assetId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!asset) return { error: "השטח אינו זמין." };
    await prisma.savedAsset.create({ data: { userId: user.id, assetId } });
    revalidatePath("/dashboard/saved");
    return { saved: true };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}
