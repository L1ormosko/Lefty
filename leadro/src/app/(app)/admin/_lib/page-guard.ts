import { notFound } from "next/navigation";
import { recordAuthzDenial } from "@/server/authz";
import { ForbiddenError, NotFoundError } from "@/server/core";
import { getPageContext } from "../../../_lib/page-context";

/**
 * Loads a page's data through a service and translates the two expected refusals:
 *  - 403 -> `{ denied: true }` (the page renders the access-denied panel),
 *  - 404 -> Next's not-found page (a record outside the caller's scope looks like a missing one).
 * Both refusals are audited as failed access. Anything else propagates to the error boundary. The service is the authority; this only picks
 * how a refusal is shown.
 */
export async function loadForPage<T>(load: () => Promise<T>): Promise<{ denied: false; data: T } | { denied: true }> {
  try {
    return { denied: false, data: await load() };
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) {
      // Services enforce silently; the page layer is where a refused web read is audited (§21 "failed access").
      const { actor } = await getPageContext();
      if (actor) await recordAuthzDenial(actor, null, { sourceApp: "WEB" });
      if (error instanceof NotFoundError) notFound();
      return { denied: true };
    }
    throw error;
  }
}

/** Reads `?name=` as a trimmed string (first value when repeated); empty means absent. */
export function queryParam(searchParams: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = searchParams[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
