import { describe, expect, it } from "vitest";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { POST as logoutRoute } from "@/app/api/v1/auth/logout/route";
import { POST as resetRequestRoute } from "@/app/api/v1/auth/password-reset/request/route";
import { GET as sessionsRoute } from "@/app/api/v1/auth/sessions/route";
import { DELETE as revokeSessionRoute } from "@/app/api/v1/auth/sessions/[sessionId]/route";
import { POST as mfaVerifyRoute } from "@/app/api/v1/auth/mfa/verify/route";
import { createTenantWithUser, resetAuthTestState, TEST_PASSWORD, uniqueEmail } from "./auth-helpers";

resetAuthTestState();

const ip = () => `198.51.100.${Math.floor(Math.random() * 250)}`;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...headers },
    body: JSON.stringify(body),
  });

async function loginViaRoute(user: { tenantSlug: string; email: string }) {
  const response = await loginRoute(post("/api/v1/auth/login", { tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD }));
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  return { response, setCookie, cookie };
}

describe("auth API routes", () => {
  it("login sets an HttpOnly, SameSite=Lax, Secure session cookie and never puts the token in the body", async () => {
    const user = await createTenantWithUser();
    const { response, setCookie, cookie } = await loginViaRoute(user);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-correlation-id")).toBeTruthy();
    expect(setCookie).toMatch(/^leadro_session=[^;]+\./);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");
    const body = await response.json();
    expect(body.data).toMatchObject({ userId: user.userId, mfaRequired: false });
    expect(JSON.stringify(body)).not.toContain(cookie.split("=")[1]);
  });

  it("a bad login returns a structured 401 with no cookie", async () => {
    const user = await createTenantWithUser();
    const response = await loginRoute(post("/api/v1/auth/login", { tenantSlug: user.tenantSlug, email: user.email, password: "wrong password here" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.json();
    expect(body.error).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
    expect(body.error.correlationId).toBeTruthy();
  });

  it("validates the login body", async () => {
    const response = await loginRoute(post("/api/v1/auth/login", { email: "x" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("sessions needs a session; with one it lists it and DELETE revokes it", async () => {
    const user = await createTenantWithUser();
    const anonymous = await sessionsRoute(new Request("http://localhost/api/v1/auth/sessions"));
    expect(anonymous.status).toBe(401);

    const { cookie } = await loginViaRoute(user);
    const listed = await sessionsRoute(new Request("http://localhost/api/v1/auth/sessions", { headers: { cookie } }));
    expect(listed.status).toBe(200);
    const sessions = (await listed.json()).data as Array<{ id: string; isCurrent: boolean }>;
    expect(sessions.some((session) => session.isCurrent)).toBe(true);
    expect(JSON.stringify(sessions)).not.toContain("tokenHash");

    const revoke = await revokeSessionRoute(
      new Request(`http://localhost/api/v1/auth/sessions/${sessions[0].id}`, { method: "DELETE", headers: { cookie } }),
      { params: Promise.resolve({ sessionId: sessions[0].id }) },
    );
    expect(revoke.status).toBe(204);
    const after = await sessionsRoute(new Request("http://localhost/api/v1/auth/sessions", { headers: { cookie } }));
    expect(after.status).toBe(401);
  });

  it("logout clears the cookie and kills the session", async () => {
    const user = await createTenantWithUser();
    const { cookie } = await loginViaRoute(user);
    const response = await logoutRoute(new Request("http://localhost/api/v1/auth/logout", { method: "POST", headers: { cookie } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(/leadro_session=;.*Max-Age=0/);
    const after = await sessionsRoute(new Request("http://localhost/api/v1/auth/sessions", { headers: { cookie } }));
    expect(after.status).toBe(401);
  });

  it("password-reset/request answers 202 with the same body for known and unknown accounts", async () => {
    const user = await createTenantWithUser();
    const known = await resetRequestRoute(post("/api/v1/auth/password-reset/request", { tenantSlug: user.tenantSlug, email: user.email }));
    const unknown = await resetRequestRoute(post("/api/v1/auth/password-reset/request", { tenantSlug: "nope", email: uniqueEmail("ghost") }));
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("login is throttled with 429 and Retry-After once a client floods it", async () => {
    const flooder = { "x-forwarded-for": "192.0.2.77" };
    let last: Response | undefined;
    for (let attempt = 0; attempt < 31; attempt++) {
      last = await loginRoute(post("/api/v1/auth/login", { tenantSlug: "nope", email: uniqueEmail("flood"), password: "x" }, flooder));
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBeTruthy();
  });

  it("MFA endpoints still require a session", async () => {
    const response = await mfaVerifyRoute(post("/api/v1/auth/mfa/verify", { code: "123456" }));
    expect(response.status).toBe(401);
  });
});
