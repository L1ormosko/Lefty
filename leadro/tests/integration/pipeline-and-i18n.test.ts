import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATALOGS } from "@/lib/i18n";
import { authenticateRequest, login, resetRateLimits } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { ConflictError, defineRoute, ERROR_CODES, ForbiddenError, HTTP_STATUS_BY_CODE, NotFoundError, ok, ValidationError, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import {
  deleteOverrideAsActor,
  loadReviewedOverrides,
  reviewOverrideAsActor,
  saveOverrideAsActor,
} from "@/server/i18n";
import { createTenantWithUser, testClient, TEST_PASSWORD } from "../auth/auth-helpers";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type World } from "../authz/fixtures";
import { auditEvents, call, contextFor, sessionCookie } from "../org/org-helpers";

let w: World;
beforeAll(async () => {
  w = await buildWorld("integration-pipeline");
});
afterAll(disconnect);
beforeEach(() => resetRateLimits());

describe("defineRoute hands the request context to authorize and to auth", () => {
  it("authorize receives the correlation id defineRoute generated; the denial is audited under it", async () => {
    let seen: RequestContext | undefined;
    const route = defineRoute({
      authenticate: authenticateRequest,
      authorize: async (actor, input, ctx) => {
        seen = ctx;
        await requirePermission("audit.view")(actor, input, ctx);
      },
      handler: async () => ok({}),
    });
    const cookie = await sessionCookie(w.techA1, w.tenantId);

    const result = await call(route, "GET", "/x", { cookie }); // no x-correlation-id header: one is generated
    expect(result.status).toBe(403);
    expect(seen?.correlationId).toBe(result.correlationId);
    expect(seen?.actor?.userId).toBe(w.techA1.userId);
    const denied = await auditEvents(w.tenantId, "authz.denied");
    expect(denied.some((event) => event.correlationId === result.correlationId && event.actorUserId === w.techA1.userId)).toBe(true);

    const supplied = await call(route, "GET", "/x", { cookie, headers: { "x-correlation-id": "caller-supplied-id-1" } });
    expect(supplied.correlationId).toBe("caller-supplied-id-1");
    expect((await auditEvents(w.tenantId, "authz.denied")).some((event) => event.correlationId === "caller-supplied-id-1")).toBe(true);
  });

  it("auth's denied-access audit uses the id defineRoute generated, not the raw header", async () => {
    const user = await createTenantWithUser();
    const session = await login({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD }, testClient());
    await withTenant(user.tenantId, (tx) => tx.session.updateMany({ where: { userId: user.userId }, data: { revokedAt: new Date() } }));
    const route = defineRoute({ authenticate: authenticateRequest, handler: async () => ok({}) });
    const cookie = `leadro_session=${session.token}`;

    const generated = await call(route, "GET", "/x", { cookie });
    expect(generated.status).toBe(401);
    // A malformed header is replaced by defineRoute; the audit must carry the replacement, not "bad id".
    const malformed = await call(route, "GET", "/x", { cookie, headers: { "x-correlation-id": "bad id" } });
    expect(malformed.correlationId).not.toBe("bad id");
    const valid = await call(route, "GET", "/x", { cookie, headers: { "x-correlation-id": "valid-caller-id-42" } });

    const events = await withTenant(user.tenantId, (tx) => tx.auditEvent.findMany({ where: { action: "auth.access_denied" } }));
    const ids = events.map((event) => event.correlationId);
    expect(ids).toContain(generated.correlationId);
    expect(ids).toContain(malformed.correlationId);
    expect(ids).toContain("valid-caller-id-42");
    expect(ids).not.toContain("bad id");
    expect(valid.correlationId).toBe("valid-caller-id-42");
  });
});

describe("translation overrides: permission-gated, audited, errors mapped to AppError", () => {
  const entries = Object.entries(CATALOGS["en-US"].messages);
  const [plainKey] = entries.find(([, text]) => !/\{\w+\}/.test(text)) ?? [];
  const [placeholderKey, placeholderText] = entries.find(([, text]) => /\{\w+\}/.test(text)) ?? [];

  const save = (actor = w.ceo.actor, value = "Custom text") => saveOverrideAsActor(actor, contextFor(actor), { locale: "en-US", key: plainKey!, value });

  it("has catalog keys to work with", () => {
    expect(plainKey).toBeTruthy();
    expect(placeholderKey).toBeTruthy();
  });

  it("refuses people without localization.edit / localization.configure", async () => {
    await expect(save(w.techA1.actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(save(w.cityManagerA.actor)).rejects.toBeInstanceOf(ForbiddenError); // may view, not edit

    const editorRole = await makeRole(w.tenantId, "translator", [{ permission: "localization.edit" }]);
    const translator = await createPerson(w.tenantId, "translator", { withEmployee: false });
    await grantTemplate(w.tenantId, translator, editorRole, [{ type: "TENANT" }]);
    await expect(save(translator.actor, "By translator")).resolves.toBeTruthy(); // edit is enough to save
    await expect(
      reviewOverrideAsActor(translator.actor, contextFor(translator.actor), { locale: "en-US", key: plainKey!, reviewedValue: "By translator" }),
    ).rejects.toBeInstanceOf(ForbiddenError); // ...but not to review (needs configure)
    await expect(deleteOverrideAsActor(translator.actor, contextFor(translator.actor), { locale: "en-US", key: plainKey! })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("saves unreviewed, audits with previous/new text, and serves it only after review", async () => {
    const saved = await save(w.ceo.actor, "First draft");
    const ctx = contextFor(w.ceo.actor);
    expect(await loadReviewedOverrides(w.tenantId)).toEqual({});

    await save(w.ceo.actor, "Second draft");
    const events = await auditEvents(w.tenantId, "translation.save", saved.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const latest = events[0];
    expect(latest.previousValue).toMatchObject({ value: "First draft" });
    expect(latest.newValue).toMatchObject({ value: "Second draft", reviewed: false });

    await reviewOverrideAsActor(w.ceo.actor, ctx, { locale: "en-US", key: plainKey!, reviewedValue: "Second draft" });
    expect((await loadReviewedOverrides(w.tenantId))["en-US"]?.[plainKey!]).toBe("Second draft");
    const [review] = await auditEvents(w.tenantId, "translation.review");
    expect(review).toMatchObject({ actorUserId: w.ceo.userId, correlationId: ctx.correlationId });

    await deleteOverrideAsActor(w.ceo.actor, ctx, { locale: "en-US", key: plainKey! });
    expect(await loadReviewedOverrides(w.tenantId)).toEqual({});
    expect((await auditEvents(w.tenantId, "translation.delete")).length).toBeGreaterThan(0);
  });

  it("maps the module's errors to AppError subclasses", async () => {
    const ctx = contextFor(w.ceo.actor);
    await expect(saveOverrideAsActor(w.ceo.actor, ctx, { locale: "fr-FR", key: plainKey!, value: "x" })).rejects.toMatchObject({ constructor: ValidationError, field: "locale" });
    await expect(saveOverrideAsActor(w.ceo.actor, ctx, { locale: "en-US", key: "NO.SUCH.KEY", value: "x" })).rejects.toMatchObject({ constructor: ValidationError, field: "key" });
    await expect(saveOverrideAsActor(w.ceo.actor, ctx, { locale: "en-US", key: placeholderKey!, value: `${placeholderText} {extra}` })).rejects.toMatchObject({ constructor: ValidationError, field: "value" });

    await save(w.ceo.actor, "Changed after load");
    await expect(reviewOverrideAsActor(w.ceo.actor, ctx, { locale: "en-US", key: plainKey!, reviewedValue: "Stale text" })).rejects.toBeInstanceOf(ConflictError);
    await expect(reviewOverrideAsActor(w.ceo.actor, ctx, { locale: "es-US", key: plainKey!, reviewedValue: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteOverrideAsActor(w.ceo.actor, ctx, { locale: "he-IL", key: plainKey! })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("another tenant's overrides are untouched and unreadable", async () => {
    const other = await buildWorld("integration-i18n-other");
    await saveOverrideAsActor(other.ceo.actor, contextFor(other.ceo.actor), { locale: "en-US", key: plainKey!, value: "Other tenant" });
    await reviewOverrideAsActor(other.ceo.actor, contextFor(other.ceo.actor), { locale: "en-US", key: plainKey!, reviewedValue: "Other tenant" });
    expect((await loadReviewedOverrides(w.tenantId))["en-US"]?.[plainKey!]).not.toBe("Other tenant");
  });
});

describe("docs/API_CONVENTIONS.md matches the code (item e)", () => {
  const doc = readFileSync(path.join(__dirname, "../../docs/API_CONVENTIONS.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Error shape"), doc.indexOf("## Idempotency"));
  const rows = [...section.matchAll(/^\| (\d{3}) \| `([A-Z_]+)` \|/gm)].map((match) => ({ status: Number(match[1]), code: match[2] }));

  it("documents exactly the codes the code defines, with the status the code uses", () => {
    expect(rows.map((row) => row.code).sort()).toEqual([...ERROR_CODES].sort());
    for (const row of rows) expect(HTTP_STATUS_BY_CODE[row.code as (typeof ERROR_CODES)[number]]).toBe(row.status);
  });
});
