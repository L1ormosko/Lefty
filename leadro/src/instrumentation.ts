/**
 * Runs once when the Next.js server starts (Node runtime only). Startup registrations live in
 * `src/server/notification-targets.ts`, which the notifications routes import as well.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNotificationTargets } = await import("@/server/notification-targets");
  registerNotificationTargets();
}
