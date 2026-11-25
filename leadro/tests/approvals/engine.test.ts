import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelApprovalForSubjectInTx,
  cancelApprovalRequest,
  createPolicy,
  createPolicySchema,
  decideApprovalRequest,
  expireDueApprovalRequests,
  getApprovalRequest,
  listApprovalQueue,
  listApprovalRequests,
  listMyApprovalRequests,
  listPolicies,
  unregisterApprovalSubject,
} from "@/server/approvals";
import { withTenant } from "@/server/db";
import { disconnect, type Person } from "../authz/fixtures";
import { auditEvents, contextFor } from "../org/org-helpers";
import { buildApprovalWorld, installTestSubjects, newSubject, openRequest, requestApproval, type ApprovalWorld } from "./fixtures";

let w: ApprovalWorld;
let other: ApprovalWorld;

beforeAll(async () => {
  w = await buildApprovalWorld("approvals");
  other = await buildApprovalWorld("approvals-other");
  // Both worlds share the process-wide registry; the second install replaced the handlers, so restore the first world's.
  installTestSubjects(w);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  unregisterApprovalSubject();
  await disconnect();
});

const approve = (person: Person, id: string, comment?: string) => decideApprovalRequest(person.actor, contextFor(person.actor), id, { decision: "APPROVE", comment });
const reject = (person: Person, id: string, comment = "Not justified") => decideApprovalRequest(person.actor, contextFor(person.actor), id, { decision: "REJECT", comment });
const callsFor = (id: string) => w.calls.filter((call) => call.requestId === id);
const statusOf = (id: string) => withTenant(w.tenantId, (tx) => tx.approvalRequest.findFirstOrThrow({ where: { id }, select: { status: true } })).then((row) => row.status);
const notificationsOf = (id: string, eventType: string) =>
  withTenant(w.tenantId, (tx) => tx.notification.findMany({ where: { targetId: id, eventType }, select: { recipientId: true } })).then((rows) => rows.map((row) => row.recipientId).sort());

describe("policy resolution and request creation", () => {
  it("snapshots the policy of the amount band, the requester and the excluded approvers", async () => {
    const result = await requestApproval(w, w.cityManagerA, { amountMinor: 49_999n, excludedApproverIds: [w.ceo.userId, w.ceo.userId] });
    if (!result.required) throw new Error("expected a request");
    expect(result.request).toMatchObject({
      status: "PENDING",
      policyCode: "refund_small",
      policyVersion: 1,
      requiredApprovals: 1,
      approverPermission: "finance_refunds.approve",
      amountMinor: 49_999n,
      currency: "USD",
      orgUnitId: w.units.cityA,
      requestedById: w.cityManagerA.userId,
      excludedApproverIds: [w.ceo.userId],
    });
    expect(result.request.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const large = await requestApproval(w, w.cityManagerA, { amountMinor: 50_000n });
    expect(large.required && large.request).toMatchObject({ policyCode: "refund_large", requiredApprovals: 2, expiresAt: null });
    expect(await auditEvents(w.tenantId, "approval_request.create", result.request.id)).toHaveLength(1);
  });

  it("needs no approval without a policy, and refuses a currency no policy covers", async () => {
    expect(await requestApproval(w, w.cityManagerA, { subjectType: "ADJUSTMENT" })).toEqual({ required: false });
    await expect(requestApproval(w, w.cityManagerA, { currency: "EUR" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", field: "currency" });
  });

  it("allows one pending request per subject and replays an idempotency key", async () => {
    const subjectId = newSubject(w);
    const first = await requestApproval(w, w.cityManagerA, { subjectId, idempotencyKey: `refund:${subjectId}` });
    const replay = await requestApproval(w, w.cityManagerA, { subjectId, idempotencyKey: `refund:${subjectId}` });
    expect(replay).toMatchObject({ required: true, replayed: true });
    expect(first.required && replay.required && replay.request.id === first.request.id).toBe(true);
    await expect(requestApproval(w, w.cityManagerA, { subjectId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(requestApproval(w, w.cityManagerA, { idempotencyKey: `refund:${subjectId}` })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses free-text details, unknown excluded users, missing subjects and unregistered subject types", async () => {
    await expect(requestApproval(w, w.cityManagerA, { details: { note: "call me back" } })).rejects.toMatchObject({ field: "details" });
    await expect(requestApproval(w, w.cityManagerA, { excludedApproverIds: [other.ceo.userId] })).rejects.toMatchObject({ field: "excludedApproverIds" });
    await expect(requestApproval(w, w.cityManagerA, { subjectId: "subject-unknown" })).rejects.toMatchObject({ field: "subjectId" });
    await expect(requestApproval(w, w.cityManagerA, { subjectType: "HIGH_VALUE_DISCOUNT" })).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("notifies the eligible approvers in scope only: not the requester, not excluded editors, not other units", async () => {
    const id = await openRequest(w, w.cityManagerA, { excludedApproverIds: [w.ceo.userId] });
    expect(await notificationsOf(id, "approval.requested")).toEqual([w.finance.userId]);
    const inB = await openRequest(w, w.cityManagerB, { orgUnitId: w.units.cityB });
    expect(await notificationsOf(inB, "approval.requested")).toEqual([w.ceo.userId, w.finance.userId, w.approverB.userId].sort());
  });
});

describe("separation of duties", () => {
  it("the requester cannot decide their own request, even holding the approver permission", async () => {
    const id = await openRequest(w, w.finance);
    await expect(approve(w.finance, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await statusOf(id)).toBe("PENDING");
    const denied = await auditEvents(w.tenantId, "approval_request.decide", id);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: "DENIED", actorUserId: w.finance.userId });
  });

  it("an editor / submitter listed as excluded cannot decide, and is left out of the queue", async () => {
    const id = await openRequest(w, w.cityManagerA, { excludedApproverIds: [w.ceo.userId] });
    await expect(approve(w.ceo, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const queue = await listApprovalQueue(w.ceo.actor, { limit: 200 });
    expect(queue.data.map((row) => row.id)).not.toContain(id);
    expect((await getApprovalRequest(w.ceo.actor, id)).viewer).toMatchObject({ canDecide: false });
    await approve(w.finance, id);
    expect(await statusOf(id)).toBe("APPROVED");
  });

  it("the database refuses a decision by the requester or an excluded user written past the service", async () => {
    const id = await openRequest(w, w.cityManagerA, { excludedApproverIds: [w.ceo.userId] });
    for (const deciderId of [w.cityManagerA.userId, w.ceo.userId]) {
      await expect(
        withTenant(w.tenantId, (tx) => tx.approvalDecision.create({ data: { tenantId: w.tenantId, requestId: id, deciderId, decision: "APPROVE" } })),
      ).rejects.toThrow(/separation of duties/);
    }
  });

  it("decisions are append-only", async () => {
    const id = await openRequest(w, w.cityManagerA);
    await reject(w.finance, id);
    await expect(withTenant(w.tenantId, (tx) => tx.approvalDecision.updateMany({ where: { requestId: id }, data: { decision: "APPROVE" } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.approvalDecision.deleteMany({ where: { requestId: id } }))).rejects.toThrow();
  });
});

describe("single and dual approval", () => {
  it("one approval completes a small request, calls the subject back once and tells the requester", async () => {
    const id = await openRequest(w, w.cityManagerA);
    const view = await approve(w.finance, id, "ok");
    expect(view).toMatchObject({ status: "APPROVED", approvalCount: 1, viewer: { myDecision: "APPROVE", canDecide: false } });
    expect(callsFor(id)).toEqual([expect.objectContaining({ outcome: "APPROVED", approverIds: [w.finance.userId], actorUserId: w.finance.userId, subjectType: "REFUND" })]);
    expect(await notificationsOf(id, "approval.decided")).toEqual([w.cityManagerA.userId]);
    expect(await auditEvents(w.tenantId, "approval_request.approved", id)).toHaveLength(1);
    expect(await auditEvents(w.tenantId, "approval_request.decide", id)).toHaveLength(1);
    await expect(approve(w.ceo, id)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  it("dual approval needs two different people; the same person cannot approve twice", async () => {
    const id = await openRequest(w, w.cityManagerA, { amountMinor: 75_000n });
    const first = await approve(w.finance, id);
    expect(first).toMatchObject({ status: "PENDING", approvalCount: 1, requiredApprovals: 2 });
    expect(callsFor(id)).toHaveLength(0);
    await expect(approve(w.finance, id)).rejects.toMatchObject({ code: "CONFLICT" });
    const second = await approve(w.ceo, id);
    expect(second).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect(callsFor(id)).toEqual([expect.objectContaining({ outcome: "APPROVED", approverIds: [w.finance.userId, w.ceo.userId] })]);
  });

  it("a rejection ends a dual request at once, with its comment", async () => {
    const id = await openRequest(w, w.cityManagerA, { amountMinor: 75_000n });
    await approve(w.finance, id);
    const view = await reject(w.ceo, id, "Duplicate of an earlier refund");
    expect(view).toMatchObject({ status: "REJECTED" });
    expect(callsFor(id)).toEqual([expect.objectContaining({ outcome: "REJECTED", reason: "Duplicate of an earlier refund", approverIds: [w.finance.userId] })]);
  });

  it("a failing subject callback rolls the decision back", async () => {
    const id = await openRequest(w, w.cityManagerA);
    w.failNextApproval.value = true;
    await expect(approve(w.finance, id)).rejects.toThrow("subject refused the approval");
    expect(await statusOf(id)).toBe("PENDING");
    expect(await withTenant(w.tenantId, (tx) => tx.approvalDecision.count({ where: { requestId: id } }))).toBe(0);
  });
});

describe("concurrent decisions", () => {
  it("two approvers of a dual request at the same moment: approved exactly once with both decisions", async () => {
    const id = await openRequest(w, w.cityManagerA, { amountMinor: 90_000n });
    const results = await Promise.allSettled([approve(w.finance, id), approve(w.ceo, id)]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await statusOf(id)).toBe("APPROVED");
    expect(callsFor(id)).toHaveLength(1);
    expect(await withTenant(w.tenantId, (tx) => tx.approvalDecision.count({ where: { requestId: id } }))).toBe(2);
  });

  it("two approvers of a single request at the same moment: one wins, the other gets 409", async () => {
    const id = await openRequest(w, w.cityManagerA);
    const results = await Promise.allSettled([approve(w.finance, id), reject(w.ceo, id)]);
    const failed = results.filter((result) => result.status === "rejected");
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(callsFor(id)).toHaveLength(1);
    expect(await withTenant(w.tenantId, (tx) => tx.approvalDecision.count({ where: { requestId: id } }))).toBe(1);
  });

  it("the same approver twice at the same moment records one decision", async () => {
    const id = await openRequest(w, w.cityManagerA, { amountMinor: 90_000n });
    const results = await Promise.allSettled([approve(w.finance, id), approve(w.finance, id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await withTenant(w.tenantId, (tx) => tx.approvalDecision.count({ where: { requestId: id } }))).toBe(1);
    expect(await statusOf(id)).toBe("PENDING");
  });
});

describe("expiry and cancellation", () => {
  it("the sweep expires overdue requests and tells the subject; an expired request leaves the queue", async () => {
    const id = await openRequest(w, w.cityManagerA);
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await expireDueApprovalRequests(w.tenantId, new Date())).toBe(0);
    expect(await expireDueApprovalRequests(w.tenantId, later)).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe("EXPIRED");
    expect(callsFor(id)).toEqual([expect.objectContaining({ outcome: "EXPIRED", actorUserId: null })]);
    expect((await auditEvents(w.tenantId, "approval_request.expired", id))[0]).toMatchObject({ actorType: "SYSTEM" });
    expect(await expireDueApprovalRequests(w.tenantId, later)).toBe(0);
  });

  it("deciding a request past its expiry expires it and answers 409", async () => {
    const id = await openRequest(w, w.cityManagerA);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 25 * 3_600_000));
    expect((await listApprovalQueue(w.finance.actor, { limit: 200 })).data.map((row) => row.id)).not.toContain(id);
    await expect(approve(w.finance, id)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    vi.useRealTimers();
    expect(await statusOf(id)).toBe("EXPIRED");
    expect(callsFor(id)).toEqual([expect.objectContaining({ outcome: "EXPIRED" })]);
  });

  it("the requester or an approvals manager cancels; an approver who is neither cannot", async () => {
    // approverB may decide City B requests but holds no approvals.manage: seeing a request is not cancelling it.
    const inB = await openRequest(w, w.cityManagerB, { orgUnitId: w.units.cityB });
    await expect(cancelApprovalRequest(w.approverB.actor, contextFor(w.approverB.actor), inB, { reason: "no" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const byRequester = await openRequest(w, w.cityManagerA);
    expect(await cancelApprovalRequest(w.cityManagerA.actor, contextFor(w.cityManagerA.actor), byRequester, { reason: "Customer withdrew" })).toMatchObject({ status: "CANCELLED", cancelReason: "Customer withdrew" });
    expect(callsFor(byRequester)).toEqual([expect.objectContaining({ outcome: "CANCELLED", reason: "Customer withdrew" })]);

    const byManager = await openRequest(w, w.cityManagerA);
    await cancelApprovalRequest(w.coo.actor, contextFor(w.coo.actor), byManager, { reason: "Opened by mistake" });
    expect(await statusOf(byManager)).toBe("CANCELLED");
    expect(await notificationsOf(byManager, "approval.decided")).toEqual([w.cityManagerA.userId]);
  });

  it("a subject module withdrawing its change cancels the request without being called back", async () => {
    const subjectId = newSubject(w);
    const id = await openRequest(w, w.cityManagerA, { subjectId });
    const cancelled = await withTenant(w.tenantId, (tx) => cancelApprovalForSubjectInTx(tx, contextFor(w.cityManagerA.actor), { tenantId: w.tenantId, subjectType: "REFUND", subjectId, reason: "Refund cancelled" }));
    expect(cancelled).toBe(id);
    expect(await statusOf(id)).toBe("CANCELLED");
    expect(callsFor(id)).toHaveLength(0);
  });
});

describe("scope and visibility", () => {
  it("an approver outside the request's unit neither sees nor decides it", async () => {
    const id = await openRequest(w, w.cityManagerA);
    expect((await listApprovalQueue(w.approverB.actor, { limit: 200 })).data.map((row) => row.id)).not.toContain(id);
    await expect(getApprovalRequest(w.approverB.actor, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(approve(w.approverB, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const inB = await openRequest(w, w.cityManagerB, { orgUnitId: w.units.cityB });
    expect((await listApprovalQueue(w.approverB.actor, { limit: 200 })).data.map((row) => row.id)).toContain(inB);
  });

  it("holding approvals.view alone shows only one's own requests", async () => {
    const mine = await openRequest(w, w.cityManagerA);
    const theirs = await openRequest(w, w.cityManagerB, { orgUnitId: w.units.cityB });
    await expect(getApprovalRequest(w.cityManagerA.actor, theirs)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listApprovalQueue(w.cityManagerA.actor, { limit: 200 })).data).toHaveLength(0);
    const own = await listMyApprovalRequests(w.cityManagerA.actor, { limit: 200 });
    expect(own.data.map((row) => row.id)).toContain(mine);
    expect(own.data.every((row) => row.requestedById === w.cityManagerA.userId)).toBe(true);
    await expect(approve(w.cityManagerB, mine)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listApprovalRequests(w.cityManagerA.actor, { limit: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an approvals manager without the approver permission sees the request but not its amount", async () => {
    const id = await openRequest(w, w.cityManagerA, { details: { paymentId: "pay-1" } });
    const view = await getApprovalRequest(w.coo.actor, id);
    expect(view).toMatchObject({ id, moneyRedacted: true, viewer: { canDecide: false, canCancel: true } });
    expect(view).not.toHaveProperty("amountMinor");
    expect(view).not.toHaveProperty("details");
    const listed = (await listApprovalRequests(w.coo.actor, { limit: 200 })).data.find((row) => row.id === id);
    expect(listed).toMatchObject({ moneyRedacted: true });
    expect(listed).not.toHaveProperty("amountMinor");
    expect(await getApprovalRequest(w.finance.actor, id)).toMatchObject({ amountMinor: 12_000n, details: { paymentId: "pay-1" }, moneyRedacted: false });
    await expect(approve(w.coo, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("users without approvals.view and users of another tenant get nothing", async () => {
    const id = await openRequest(w, w.cityManagerA);
    await expect(getApprovalRequest(w.techA1.actor, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listApprovalQueue(w.techA1.actor, { limit: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getApprovalRequest(other.finance.actor, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(approve(other.finance, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listApprovalQueue(other.finance.actor, { limit: 200 })).data.map((row) => row.id)).not.toContain(id);
  });

  it("system requests (no requester) reach the queue", async () => {
    const id = await openRequest(w, null);
    expect((await listApprovalQueue(w.finance.actor, { limit: 200 })).data.map((row) => row.id)).toContain(id);
  });
});

describe("policies", () => {
  it("a new version of a code replaces the active one; pending requests keep their snapshot", async () => {
    const pending = await openRequest(w, w.cityManagerA, { amountMinor: 100n });
    const ctx = contextFor(w.finance.actor);
    const v2 = await createPolicy(w.finance.actor, ctx, createPolicySchema.parse({ code: "refund_small", subjectType: "REFUND", name: "Small refund v2", maxAmountMinor: 50_000, requiredApprovals: 2, approverPermission: "finance_refunds.approve" }));
    expect(v2).toMatchObject({ version: 2, active: true, requiredApprovals: 2 });
    const active = await listPolicies(w.finance.actor, { limit: 50, activeOnly: "true", code: "refund_small" });
    expect(active.data.map((row) => row.version)).toEqual([2]);
    expect((await getApprovalRequest(w.finance.actor, pending))).toMatchObject({ policyVersion: 1, requiredApprovals: 1 });
    const fresh = await requestApproval(w, w.cityManagerA, { amountMinor: 100n });
    expect(fresh.required && fresh.request).toMatchObject({ policyVersion: 2, requiredApprovals: 2 });
  });

  it("refuses overlapping bands, unknown approver permissions, another subject type for a code, and non-configurers", async () => {
    const ctx = contextFor(w.finance.actor);
    const base = { subjectType: "REFUND", name: "x", approverPermission: "finance_refunds.approve" };
    await expect(createPolicy(w.finance.actor, ctx, createPolicySchema.parse({ ...base, code: "refund_mid", minAmountMinor: 10_000, maxAmountMinor: 60_000 }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createPolicy(w.finance.actor, ctx, createPolicySchema.parse({ ...base, code: "refund_eur", currency: "EUR", approverPermission: "nothing.approve" }))).rejects.toMatchObject({ field: "approverPermission" });
    await expect(createPolicy(w.finance.actor, ctx, createPolicySchema.parse({ ...base, code: "refund_large", subjectType: "ADJUSTMENT" }))).rejects.toMatchObject({ field: "subjectType" });
    await expect(createPolicy(w.cityManagerA.actor, contextFor(w.cityManagerA.actor), createPolicySchema.parse({ ...base, code: "refund_eur", currency: "EUR" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listPolicies(w.coo.actor, { limit: 50, activeOnly: "true" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
