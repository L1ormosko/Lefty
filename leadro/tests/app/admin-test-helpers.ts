import { SESSION_COOKIE_NAME } from "@/server/auth";
import type { Person } from "../authz/fixtures";
import { sessionCookie } from "../org/org-helpers";
import { setFakeCookie } from "./next-fakes";

/*
 * Test files that call server actions declare, at module top level (vi.mock is hoisted there):
 *
 *   vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
 *   vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
 *   vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);
 */

/** Opens a real session for a fixture person and puts its cookie in the fake browser. */
export async function signInPerson(person: Person, tenantId: string): Promise<void> {
  const header = await sessionCookie(person, tenantId);
  setFakeCookie(SESSION_COOKIE_NAME, header.slice(`${SESSION_COOKIE_NAME}=`.length));
}

/** FormData from a plain object (undefined values are skipped). */
export function form(values: Record<string, string | undefined>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) data.set(key, value);
  return data;
}
