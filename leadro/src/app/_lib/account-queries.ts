import { cache } from "react";
import type { Actor } from "@/server/core";
import { getOwnAccountSummary, type OwnAccountSummary } from "@/server/users";

/**
 * The caller's own account facts for the shell header and the MFA / security pages. The data comes
 * from the users service (`getOwnAccountSummary`); `cache` only shares one lookup between the
 * layout and the page of a single request.
 */
export const loadAccountSummary = cache((actor: Actor): Promise<OwnAccountSummary> => getOwnAccountSummary(actor));

/** Whether the caller already has a working authenticator (decides enroll vs. verify screens). */
export async function loadMfaEnabled(actor: Actor): Promise<boolean> {
  return (await loadAccountSummary(actor)).mfaEnabled;
}
