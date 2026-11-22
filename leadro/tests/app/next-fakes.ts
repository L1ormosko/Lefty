import { vi } from "vitest";

/**
 * In-memory stand-ins for the parts of `next/*` that server actions and layouts touch, so the
 * real action code can run under Vitest against the real database. Each test file wires them with
 *
 *   vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
 *   vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
 *   vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);
 */

/** `redirect()` in Next throws; the fake throws this so tests can assert the destination. */
export class RedirectSignal extends Error {
  constructor(readonly destination: string) {
    super(`redirect:${destination}`);
  }
}

export interface RecordedCookie {
  value: string;
  options: Record<string, unknown>;
}

const cookieJar = new Map<string, RecordedCookie>();
let requestHeaders = new Headers();

/** Clears cookies and headers; call in `beforeEach`. */
export function resetFakeRequest(): void {
  cookieJar.clear();
  requestHeaders = new Headers();
  revalidatePath.mockClear();
}

export function setFakeCookie(name: string, value: string): void {
  cookieJar.set(name, { value, options: {} });
}

export function setFakeHeader(name: string, value: string): void {
  requestHeaders.set(name, value);
}

/** The cookie as the browser would hold it: expired or empty values are gone. */
export function getFakeCookie(name: string): string | undefined {
  return cookieJar.get(name)?.value;
}

export function getFakeCookieOptions(name: string): Record<string, unknown> | undefined {
  return cookieJar.get(name)?.options;
}

export const revalidatePath = vi.fn();

export const headersModule = {
  cookies: async () => ({
    get: (name: string) => {
      const cookie = cookieJar.get(name);
      return cookie && cookie.value !== "" ? { name, value: cookie.value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      const expires = options.expires instanceof Date ? options.expires.getTime() : Number.POSITIVE_INFINITY;
      if (value === "" || expires <= Date.now()) cookieJar.delete(name);
      else cookieJar.set(name, { value, options });
    },
  }),
  headers: async () => requestHeaders,
};

/** `notFound()` in Next throws; the fake throws this so tests can assert a 404 page. */
export class NotFoundSignal extends Error {
  constructor() {
    super("not-found");
  }
}

export const navigationModule = {
  notFound: (): never => {
    throw new NotFoundSignal();
  },
  redirect: (destination: string): never => {
    throw new RedirectSignal(destination);
  },
};

export const cacheModule = { revalidatePath };

/** Runs `fn` and returns where it redirected to (undefined if it returned normally). */
export async function redirectOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.destination;
    throw error;
  }
  return undefined;
}
