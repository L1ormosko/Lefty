/** Emails are stored lower-cased (DB CHECK) and unique per tenant, so compare them normalised. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
