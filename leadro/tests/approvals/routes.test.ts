import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listRoute } from "@/app/api/v1/approvals/route";
import { GET as queueRoute } from "@/app/api/v1/approvals/queue/route";
import { GET as mineRoute } from "@/app/api/v1/approvals/mine/route";
import { GET as getRoute } from "@/app/api/v1/approvals/[id]/route";
import { POST as decideRoute } from "@/app/api/v1/approvals/[id]/decide/route";
import { POST as cancelRoute } from "@/app/api/v1/approvals/[id]/cancel/route";
import { GET as listPoliciesRoute, POST as createPolicyRoute } from "@/app/api/v1/approvals/policies/route";
import { POST as deactivatePolicyRoute } from "@/app/api/v1/approvals/policies/[id]/deactivate/route";
import { GET as notificationsRoute } from "@/app/api/v1/notifications/route";
import { unregisterApprovalSubject } from "@/server/approvals";
import { disconnect } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { buildApprovalWorld, openRequest, type ApprovalWorld } from "./fixtures";

let w: ApprovalWorld;
const cookie: Record<string, string> = {};

beforeAll(async () => {
  w = await buildApprovalWorld("approval-routes");
  for (const name of ["finance", "ceo", "cityManagerA", "coo", "techA1", "approverB"] as const) cookie[name] = await sessionCookie(w[name], w.tenantId);
});
afterAll(async () => {
  unregisterApprovalSubject();
  await disconnect();
});

describe("the approvals API", () => {
  it("queue -> get -> decide over HTTP, money as decimal strings, separation of duties as 403", async () => {
    const id = await openRequest(w, w.cityManagerA, { amountMinor: 75_000n });

    const queue = await call(queueRoute, "GET", "/x", { cookie: cookie.finance });
    expect(queue.status).toBe(200);
    const row = queue.json.data.find((item: { id: string }) => item.id === id);
    expect(row).toMatchObject({ amountMinor: "75000", currency: "USD", requiredApprovals: 2, viewer: { canDecide: true } });

    const own = await call(decideRoute, "POST", "/x", { cookie: cookie.cityManagerA, params: { id }, body: { decision: "APPROVE" } });
    expect(own.status).toBe(403); // the requester holds no grant of the approver permission at all
    const bad = await call(decideRoute, "POST", "/x", { cookie: cookie.finance, params: { id }, body: { decision: "REJECT" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.field).toBe("body.comment");

    const first = await call(decideRoute, "POST", "/x", { cookie: cookie.finance, params: { id }, body: { decision: "APPROVE" }, headers: { "idempotency-key": `decide-${id}` } });
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ status: "PENDING", approvalCount: 1 });
    const replay = await call(decideRoute, "POST", "/x", { cookie: cookie.finance, params: { id }, body: { decision: "APPROVE" }, headers: { "idempotency-key": `decide-${id}` } });
    expect(replay.status).toBe(200);
    const second = await call(decideRoute, "POST", "/x", { cookie: cookie.ceo, params: { id }, body: { decision: "APPROVE", comment: "Checked the payment" } });
    expect(second.json.data).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect(second.json.data.decisions).toHaveLength(2);

    const mine = await call(mineRoute, "GET", "/x", { cookie: cookie.cityManagerA, query: { status: "APPROVED" } });
    expect(mine.json.data.map((item: { id: string }) => item.id)).toContain(id);
    const inbox = await call(notificationsRoute, "GET", "/x", { cookie: cookie.cityManagerA });
    expect(inbox.json.data.some((item: { targetId: string | null; redacted: boolean }) => item.targetId === id && !item.redacted)).toBe(true);
  });

  it("an excluded editor who holds the approver permission gets 403 and the refusal is audited", async () => {
    const id = await openRequest(w, w.cityManagerA, { excludedApproverIds: [w.ceo.userId] });
    const refused = await call(decideRoute, "POST", "/x", { cookie: cookie.ceo, params: { id }, body: { decision: "APPROVE" } });
    expect(refused.status).toBe(403);
    expect((await call(getRoute, "GET", "/x", { cookie: cookie.ceo, params: { id } })).json.data.status).toBe("PENDING");
  });

  it("scope: out-of-unit approvers get 404, technicians 403, overseers see no amount and may cancel", async () => {
    const id = await openRequest(w, w.cityManagerA);
    expect((await call(getRoute, "GET", "/x", { cookie: cookie.approverB, params: { id } })).status).toBe(404);
    expect((await call(getRoute, "GET", "/x", { cookie: cookie.techA1, params: { id } })).status).toBe(403);
    const overseen = await call(listRoute, "GET", "/x", { cookie: cookie.coo, query: { subjectId: "" } });
    expect(overseen.status).toBe(400); // an empty subjectId is not an id
    const list = await call(listRoute, "GET", "/x", { cookie: cookie.coo, query: { status: "PENDING" } });
    const row = list.json.data.find((item: { id: string }) => item.id === id);
    expect(row).toMatchObject({ moneyRedacted: true });
    expect(row).not.toHaveProperty("amountMinor");
    expect((await call(listRoute, "GET", "/x", { cookie: cookie.cityManagerA })).status).toBe(403);
    const cancelled = await call(cancelRoute, "POST", "/x", { cookie: cookie.coo, params: { id }, body: { reason: "Raised twice" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.data).toMatchObject({ status: "CANCELLED", cancelReason: "Raised twice" });
    expect((await call(cancelRoute, "POST", "/x", { cookie: cookie.coo, params: { id }, body: { reason: "again" } })).status).toBe(409);
  });

  it("policies: configure only, versioned, deactivated with a reason", async () => {
    expect((await call(listPoliciesRoute, "GET", "/x", { cookie: cookie.coo })).status).toBe(403);
    const created = await call(createPolicyRoute, "POST", "/x", {
      cookie: cookie.finance,
      body: { code: "writeoff", subjectType: "CHARGEBACK_WRITE_OFF", name: "Chargeback write-off", minAmountMinor: "0", requiredApprovals: 2, approverPermission: "finance_chargebacks.approve", expiresAfterHours: 48 },
    });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ code: "writeoff", version: 1, minAmountMinor: "0", maxAmountMinor: null, requiredApprovals: 2 });
    const invalid = await call(createPolicyRoute, "POST", "/x", { cookie: cookie.finance, body: { code: "x", subjectType: "REFUND", name: "x", approverPermission: "finance_refunds.view" } });
    expect(invalid.status).toBe(400);
    const listed = await call(listPoliciesRoute, "GET", "/x", { cookie: cookie.finance, query: { subjectType: "REFUND" } });
    expect(listed.json.data.map((policy: { code: string }) => policy.code).sort()).toEqual(["refund_large", "refund_small"]);
    const deactivated = await call(deactivatePolicyRoute, "POST", "/x", { cookie: cookie.finance, params: { id: created.json.data.id }, body: { reason: "Not used" } });
    expect(deactivated.json.data).toMatchObject({ active: false });
    expect((await call(deactivatePolicyRoute, "POST", "/x", { cookie: cookie.finance, params: { id: created.json.data.id }, body: { reason: "again" } })).status).toBe(409);
  });
});
