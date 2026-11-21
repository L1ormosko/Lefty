"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { logout, revokeOwnSession } from "@/server/auth";
import { NotFoundError } from "@/server/core";
import { getPageContext, requireFullSession } from "../_lib/page-context";
import { getClientInfo } from "../_lib/request-client";
import { clearSessionCookie } from "../_lib/session-cookie";

/** Ends the current session (also usable while MFA is pending) and returns to the login screen. */
export async function logoutAction(): Promise<void> {
  const { actor } = await getPageContext();
  if (actor) await logout(actor, await getClientInfo());
  await clearSessionCookie();
  redirect("/login");
}

/**
 * Revokes one of the caller's OTHER sessions. The service answers NotFound for ids that are not
 * the caller's own, so a forged id changes nothing and confirms nothing. Revoking the current
 * session goes through `logoutAction` instead, which also clears the cookie.
 */
export async function revokeSessionAction(formData: FormData): Promise<void> {
  const { actor } = await requireFullSession();
  const sessionId = String(formData.get("sessionId") ?? "");
  if (!sessionId || sessionId === actor.sessionId) return;
  try {
    await revokeOwnSession(actor, sessionId, await getClientInfo());
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  revalidatePath("/account/sessions");
}
