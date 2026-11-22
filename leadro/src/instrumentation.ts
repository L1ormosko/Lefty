/**
 * Runs once when the Next.js server starts (Node runtime only). Modules that must tell another module something at
 * startup register here, because the module that needs the information (notifications) never imports them.
 * Add further `register...()` calls to this list; each one must be idempotent.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerLeadNotifications } = await import("@/server/leads");
  registerLeadNotifications();
}
