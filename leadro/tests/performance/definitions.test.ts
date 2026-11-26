import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelApprovalRequest, cancelApprovalSchema, decideApprovalRequest, decideApprovalSchema } from "@/server/approvals";
import { withTenant } from "@/server/db";
import {
  createDefinition,
  createDefinitionSchema,
  createDefinitionVersion,
  createVersionSchema,
  getDefinition,
  getMetricCatalog,
  listDefinitions,
  listDefinitionsQuerySchema,
  reasonSchema,
  retireDefinition,
  submitDefinition,
  submitDefinitionSchema,
  updateDefinition,
  updateDefinitionSchema,
  withdrawDefinition,
} from "@/server/performance";
import { disconnect } from "../authz/fixtures";
import { contextFor } from "../org/org-helpers";
import { buildPerformanceWorld, makeDefinition, publish, type PerformanceWorld } from "./fixtures";

let w: PerformanceWorld;
let noPolicy: PerformanceWorld;

beforeAll(async () => {
  w = await buildPerformanceWorld("perf-defs");
  noPolicy = await buildPerformanceWorld("perf-nopolicy", { withPolicy: false });
});
afterAll(disconnect);

const hrCtx = () => contextFor(w.hr.actor);
const statusOf = (world: PerformanceWorld, id: string) =>
  withTenant(world.tenantId, (tx) => tx.performanceMetricDefinition.findFirstOrThrow({ where: { id }, select: { status: true, approvalRequestId: true, publishedAt: true, retiredAt: true } }));

describe("authoring metric definitions", () => {
  it("HR creates version 1 as DRAFT with normalized params and the kind's dimension", async () => {
    const created = await createDefinition(w.hr.actor, hrCtx(), createDefinitionSchema.parse({ key: "repeat_visits", kind: "REPEAT_VISIT_RATE", name: "Repeat visits", params: { windowDays: 30 }, minSample: 5 }));
    expect(created).toMatchObject({ key: "repeat_visits", version: 1, status: "DRAFT", dimension: "REPEAT_VISITS", params: { breakdown: "JOB_TYPE", windowDays: 30 }, evidenceTable: "Job" });
  });

  it("refuses unknown params, a missing window and a reused key", async () => {
    await expect(createDefinition(w.hr.actor, hrCtx(), createDefinitionSchema.parse({ key: "weighted", kind: "OUTCOME_CONVERSION", name: "W", params: { weight: 3 }, minSample: 1 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createDefinition(w.hr.actor, hrCtx(), createDefinitionSchema.parse({ key: "no_window", kind: "REPEAT_VISIT_RATE", name: "W", minSample: 1 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createDefinition(w.hr.actor, hrCtx(), createDefinitionSchema.parse({ key: "repeat_visits", kind: "ON_TIME_ARRIVAL", name: "Dup", minSample: 1 }))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("only performance.configure at tenant scope authors (managers, technicians and the COO cannot)", async () => {
    const input = createDefinitionSchema.parse({ key: "forbidden_one", kind: "ON_TIME_ARRIVAL", name: "x", minSample: 1 });
    for (const person of [w.cityManagerA, w.techA1, w.dispatcher]) {
      await expect(createDefinition(person.actor, contextFor(person.actor), input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("edits a draft, keeps the kind and refuses edits once submitted", async () => {
    const { id } = await makeDefinition(w, { kind: "ON_TIME_ARRIVAL" }, "DRAFT");
    const updated = await updateDefinition(w.hr.actor, hrCtx(), id, updateDefinitionSchema.parse({ minSample: 10, params: { breakdown: "JOB_CATEGORY" } }));
    expect(updated).toMatchObject({ minSample: 10, params: { breakdown: "JOB_CATEGORY" }, kind: "ON_TIME_ARRIVAL" });
    await submitDefinition(w.hr.actor, hrCtx(), id, submitDefinitionSchema.parse({}));
    await expect(updateDefinition(w.hr.actor, hrCtx(), id, updateDefinitionSchema.parse({ minSample: 3 }))).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  it("allows one open version per key", async () => {
    const { id } = await makeDefinition(w, { kind: "OUTCOME_CONVERSION" }, "DRAFT");
    await expect(createDefinitionVersion(w.hr.actor, hrCtx(), id, createVersionSchema.parse({}))).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("publication through the approval engine", () => {
  it("submit opens a request; the author cannot decide it; the Owner publishes", async () => {
    const { id } = await makeDefinition(w, { kind: "OUTCOME_CONVERSION" }, "DRAFT");
    const submitted = await submitDefinition(w.hr.actor, hrCtx(), id, submitDefinitionSchema.parse({ reason: "Quarterly review" }));
    expect(submitted).toMatchObject({ status: "PENDING_APPROVAL" });
    const requestId = submitted.approvalRequestId as string;
    expect(requestId).toBeTruthy();
    // HR holds no performance.publish; the author is excluded anyway.
    await expect(decideApprovalRequest(w.hr.actor, contextFor(w.hr.actor), requestId, decideApprovalSchema.parse({ decision: "APPROVE" }))).rejects.toBeTruthy();
    await decideApprovalRequest(w.ceo.actor, contextFor(w.ceo.actor), requestId, decideApprovalSchema.parse({ decision: "APPROVE" }));
    expect(await statusOf(w, id)).toMatchObject({ status: "PUBLISHED", approvalRequestId: requestId });
    const audit = await withTenant(w.tenantId, (tx) => tx.auditEvent.findFirst({ where: { targetId: id, action: "performance_metric_definition.publish" } }));
    expect(audit).not.toBeNull();
  });

  it("publishing version 2 retires version 1 in the same decision", async () => {
    const { id: v1, key } = await makeDefinition(w, { kind: "CUSTOMER_FEEDBACK_AVERAGE" });
    const v2 = await createDefinitionVersion(w.hr.actor, hrCtx(), v1, createVersionSchema.parse({ minSample: 7 }));
    expect(v2).toMatchObject({ key, version: 2, status: "DRAFT", minSample: 7, kind: "CUSTOMER_FEEDBACK_AVERAGE" });
    await publish(w, v2.id as string);
    expect((await statusOf(w, v1)).status).toBe("RETIRED");
    expect((await statusOf(w, v2.id as string)).status).toBe("PUBLISHED");
  });

  it("a rejection, a cancellation and a withdrawal send the version back to DRAFT", async () => {
    const { id } = await makeDefinition(w, { kind: "TRAINING_PROGRESS" }, "DRAFT");
    const first = await submitDefinition(w.hr.actor, hrCtx(), id, submitDefinitionSchema.parse({}));
    await decideApprovalRequest(w.ceo.actor, contextFor(w.ceo.actor), first.approvalRequestId as string, decideApprovalSchema.parse({ decision: "REJECT", comment: "Minimum sample too low" }));
    expect((await statusOf(w, id)).status).toBe("DRAFT");

    const second = await submitDefinition(w.hr.actor, hrCtx(), id, submitDefinitionSchema.parse({}));
    expect(second.approvalRequestId).not.toBe(first.approvalRequestId);
    await cancelApprovalRequest(w.ceo.actor, contextFor(w.ceo.actor), second.approvalRequestId as string, cancelApprovalSchema.parse({ reason: "Changing it" }));
    expect((await statusOf(w, id)).status).toBe("DRAFT");

    await submitDefinition(w.hr.actor, hrCtx(), id, submitDefinitionSchema.parse({}));
    const withdrawn = await withdrawDefinition(w.hr.actor, hrCtx(), id, reasonSchema.parse({ reason: "Not yet" }));
    expect(withdrawn).toMatchObject({ status: "DRAFT" });
    const request = await withTenant(w.tenantId, (tx) => tx.approvalRequest.findFirstOrThrow({ where: { subjectId: id }, orderBy: { createdAt: "desc" }, select: { status: true } }));
    expect(request.status).toBe("CANCELLED");
  });

  it("refuses to publish without an approval policy (never applies directly)", async () => {
    const created = await createDefinition(noPolicy.hr.actor, contextFor(noPolicy.hr.actor), createDefinitionSchema.parse({ key: "on_time", kind: "ON_TIME_ARRIVAL", name: "On time", minSample: 1 }));
    await expect(submitDefinition(noPolicy.hr.actor, contextFor(noPolicy.hr.actor), created.id as string, submitDefinitionSchema.parse({}))).rejects.toMatchObject({
      code: "CONFLICT",
      details: [expect.objectContaining({ code: "performance.publication_policy_missing" })],
    });
    expect(await statusOf(noPolicy, created.id as string)).toMatchObject({ status: "DRAFT", approvalRequestId: null, publishedAt: null });
  });

  it("the database refuses a published version without an approval request", async () => {
    const { id } = await makeDefinition(w, { kind: "ON_TIME_ARRIVAL" }, "DRAFT");
    await expect(withTenant(w.tenantId, (tx) => tx.performanceMetricDefinition.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: new Date() } }))).rejects.toThrow();
  });
});

describe("retiring and reading definitions", () => {
  it("retires a published version and discards a draft; a pending one must be withdrawn", async () => {
    const published = await makeDefinition(w, { kind: "RECOVERY_CONVERSION" });
    expect(await retireDefinition(w.hr.actor, hrCtx(), published.id, reasonSchema.parse({ reason: "No longer used" }))).toMatchObject({ status: "RETIRED" });
    const draft = await makeDefinition(w, { kind: "RECOVERY_CONVERSION" }, "DRAFT");
    expect(await retireDefinition(w.hr.actor, hrCtx(), draft.id, reasonSchema.parse({ reason: "Mistake" }))).toMatchObject({ status: "RETIRED", publishedAt: null });
    const pending = await makeDefinition(w, { kind: "RECOVERY_CONVERSION" }, "DRAFT");
    await submitDefinition(w.hr.actor, hrCtx(), pending.id, submitDefinitionSchema.parse({}));
    await expect(retireDefinition(w.hr.actor, hrCtx(), pending.id, reasonSchema.parse({ reason: "x" }))).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  it("non-authors see only versions that were published; authors see everything", async () => {
    const draft = await makeDefinition(w, { kind: "DOCUMENTATION_COMPLETENESS" }, "DRAFT");
    const published = await makeDefinition(w, { kind: "DOCUMENTATION_COMPLETENESS" });
    const forTech = await listDefinitions(w.techA1.actor, listDefinitionsQuerySchema.parse({ limit: 200 }));
    const techIds = forTech.data.map((row) => row.id);
    expect(techIds).toContain(published.id);
    expect(techIds).not.toContain(draft.id);
    expect(forTech.data.every((row) => row.publishedAt !== null)).toBe(true);
    await expect(getDefinition(w.techA1.actor, draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getDefinition(w.hr.actor, draft.id)).toMatchObject({ status: "DRAFT" });
    // The Dispatcher holds no performance permission at all (spec 10.3).
    await expect(listDefinitions(w.dispatcher.actor, listDefinitionsQuerySchema.parse({}))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the catalog lists the seven kinds with their dimension and evidence table", async () => {
    const catalog = await getMetricCatalog(w.techA1.actor);
    expect(catalog).toHaveLength(7);
    expect(catalog.find((entry) => entry.kind === "TRAINING_PROGRESS")).toMatchObject({ breakdowns: [], evidenceTable: "TrainingAssignment" });
  });
});
