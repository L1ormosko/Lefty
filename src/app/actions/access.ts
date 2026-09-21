"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requireRole } from "@/server/auth";
import { toUserMessage } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { viewerAccess } from "@/server/subscription";
import { createAccessRequest, resolveAccessRequest } from "@/server/access-requests";
import { t } from "@/lib/labels";
import type { ActionState } from "./inquiries";

/**
 * A signed-in customer asking to be let in.
 *
 * The button this backs is the one that was missing. Before it, an account
 * whose trial had ended read "for renewal - contact us" with nothing to press,
 * and every other route on the screen pointed at /register, which they had
 * already done.
 */
export async function requestAccessAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireUser();

    // Refused for someone who already has what they are asking for. Not a
    // technicality: a paid customer who files a request would sit in the
    // admin queue waiting for something they already have.
    const access = await viewerAccess(user);
    if (access.full) return { ok: false, error: t("access.alreadyFull") };

    // Generous, because the honest case is one request. This is here so a
    // stuck form or a script cannot fill the queue.
    if (!rateLimit(`access-request:${user.id}`, 5, 60 * 60_000).ok) {
      return { ok: false, error: t("access.tooMany") };
    }

    await createAccessRequest({
      userId: user.id,
      userEmail: user.email,
      message: String(formData.get("message") ?? ""),
    });

    revalidatePath("/access");
    revalidatePath("/admin/access");
    return { ok: true, message: t("access.sent") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

/**
 * An admin closing a request.
 *
 * Closing is not granting. The subscription is recorded separately on
 * /admin/users against an invoice, and merging the two would make it a
 * misclick away to hand out the product.
 */
export async function resolveAccessRequestAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const admin = await requireRole("ADMIN");
    const requestId = String(formData.get("requestId") ?? "");
    const decision = String(formData.get("decision") ?? "");
    if (decision !== "RESOLVED" && decision !== "DISMISSED") {
      return { ok: false, error: "החלטה לא תקינה." };
    }

    const result = await resolveAccessRequest({
      requestId,
      adminId: admin.id,
      status: decision,
      note: String(formData.get("note") ?? ""),
    });
    if (!result) return { ok: false, error: "הבקשה לא נמצאה." };

    revalidatePath("/admin/access");
    revalidatePath("/admin");
    return { ok: true, message: t("admin.accessResolved") };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}
