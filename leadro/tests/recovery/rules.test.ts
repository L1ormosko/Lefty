import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import {
  activateRule,
  createRule,
  createRuleSchema,
  deactivateRule,
  dryRunRule,
  dryRunSchema,
  getRule,
  listRules,
  listRulesQuerySchema,
  newRuleVersion,
  submitRule,
  updateRule,
  updateRuleSchema,
} from "@/server/recovery";
import { disconnect } from "../authz/fixtures";
import { auditEvents, contextFor } from "../org/org-helpers";
import { buildRecoveryWorld, makeActiveRule, makeOutcome, makeSiteJob, type RecoveryWorld } from "./fixtures";

let w: RecoveryWorld;
let seq = 0;

beforeAll(async () => {
  w = await buildRecoveryWorld("recovery-rules");
});
afterAll(disconnect);

const create = (person: { actor: RecoveryWorld["ceo"]["actor"] }, fields: Record<string, unknown> = {}) =>
  createRule(person.actor, contextFor(person.actor), createRuleSchema.parse({ ruleKey: `r-${(seq += 1)}`, name: "Rule", orgUnitId: w.units.cityA, conditions: {}, actions: [{ type: "create_case" }], ...fields }));
const ctx = (person: { actor: RecoveryWorld["ceo"]["actor"] }) => contextFor(person.actor);

describe("authoring rules", () => {
  it("creates a versioned DRAFT, derives highImpact from the actions and audits it", async () => {
    const plain = await create(w.leadOps);
    expect(plain).toMatchObject({ version: 1, status: "DRAFT", highImpact: false, needsApproval: false, createdById: w.leadOps.userId });
    const high = await create(w.leadOps, { actions: [{ type: "create_case" }, { type: "notify", audience: "lead_operations" }] });
    expect(high).toMatchObject({ highImpact: true, needsApproval: true });
    expect((await auditEvents(w.tenantId, "recovery_rule.create", String(high.id)))[0].actorUserId).toBe(w.leadOps.userId);
  });

  it("refuses discounts, unknown triggers and unknown keys; a duplicate key is a conflict", async () => {
    await expect(create(w.leadOps, { actions: [{ type: "create_case" }, { type: "apply_discount", percent: 10 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(create(w.leadOps, { actions: [{ type: "recommend", code: "call_customer", discountPercent: 5 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(create(w.leadOps, { trigger: "lead.created" })).rejects.toBeInstanceOf(ValidationError);
    await expect(create(w.leadOps, { conditions: { favouriteColour: "red" } })).rejects.toBeInstanceOf(ValidationError);
    await create(w.leadOps, { ruleKey: "dup-key" });
    await expect(create(w.leadOps, { ruleKey: "dup-key" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("scopes authoring: Lead Ops over City A cannot author for City B or for the whole tenant; a technician cannot at all", async () => {
    await expect(create(w.leadOps, { orgUnitId: w.units.cityB })).rejects.toBeInstanceOf(NotFoundError);
    await expect(create(w.leadOps, { orgUnitId: undefined })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(create(w.techA1, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(await create(w.ceo, { orgUnitId: undefined })).toMatchObject({ orgUnitId: null });
  });

  it("edits a draft in place and re-derives highImpact; a non-draft cannot be edited", async () => {
    const draft = await create(w.leadOps);
    const edited = await updateRule(w.leadOps.actor, ctx(w.leadOps), String(draft.id), updateRuleSchema.parse({ actions: [{ type: "create_follow_up", dueInMinutes: 60 }], name: "Renamed" }));
    expect(edited).toMatchObject({ name: "Renamed", highImpact: true, version: 1 });
    const active = await makeActiveRule(w, {});
    await expect(updateRule(w.leadOps.actor, ctx(w.leadOps), active, updateRuleSchema.parse({ name: "x" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });
});

describe("approval and separation of duties (§21.3)", () => {
  it("a high-impact rule must be submitted, approved by recovery.approve, and never by its author", async () => {
    const rule = String((await create(w.leadOps, { actions: [{ type: "create_case", priority: "URGENT" }] })).id);
    await expect(activateRule(w.ceo.actor, ctx(w.ceo), rule)).rejects.toBeInstanceOf(InvalidStateTransitionError); // not submitted yet
    await submitRule(w.leadOps.actor, ctx(w.leadOps), rule);
    // Lead Ops authors but holds no recovery.approve.
    await expect(activateRule(w.leadOps.actor, ctx(w.leadOps), rule)).rejects.toBeInstanceOf(ForbiddenError);
    const active = await activateRule(w.ceo.actor, ctx(w.ceo), rule);
    expect(active).toMatchObject({ status: "ACTIVE", approvedById: w.ceo.userId });
    expect((await auditEvents(w.tenantId, "recovery_rule.approve", rule))[0].actorUserId).toBe(w.ceo.userId);
  });

  it("the author cannot approve their own rule even when they hold recovery.approve", async () => {
    const rule = String((await create(w.ceo, { orgUnitId: undefined, actions: [{ type: "notify", audience: "lead_operations" }, { type: "create_case" }] })).id);
    await submitRule(w.ceo.actor, ctx(w.ceo), rule);
    await expect(activateRule(w.ceo.actor, ctx(w.ceo), rule)).rejects.toThrow(/someone other than its author/);
    // The database refuses it as well: a direct write cannot bypass the service.
    await expect(
      withTenant(w.tenantId, (tx) => tx.recoveryRule.update({ where: { id: rule }, data: { status: "ACTIVE", activatedAt: new Date(), approvedById: w.ceo.userId, approvedAt: new Date() } })),
    ).rejects.toThrow();
  });

  it("a rule that is not high impact is activated directly with recovery.manage; submit is refused", async () => {
    const rule = String((await create(w.leadOps, { actions: [{ type: "create_case" }, { type: "recommend", code: "call_customer" }] })).id);
    await expect(submitRule(w.leadOps.actor, ctx(w.leadOps), rule)).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect(await activateRule(w.leadOps.actor, ctx(w.leadOps), rule)).toMatchObject({ status: "ACTIVE", highImpact: false });
  });

  it("an approver can reject a pending rule", async () => {
    const rule = String((await create(w.leadOps, { actions: [{ type: "create_follow_up", dueInMinutes: 30 }, { type: "create_case" }] })).id);
    await submitRule(w.leadOps.actor, ctx(w.leadOps), rule);
    expect(await deactivateRule(w.ceo.actor, ctx(w.ceo), rule, { reason: "Too noisy" })).toMatchObject({ status: "INACTIVE" });
    expect((await auditEvents(w.tenantId, "recovery_rule.reject", rule)).length).toBe(1);
  });
});

describe("versions", () => {
  it("a new version is a new DRAFT row; activating it supersedes the old one; the old row keeps its content", async () => {
    const v1 = await makeActiveRule(w, { ruleKey: "versioned", actions: [{ type: "create_case" }] });
    const draft = await newRuleVersion(w.leadOps.actor, ctx(w.leadOps), v1);
    expect(draft).toMatchObject({ ruleKey: "versioned", version: 2, status: "DRAFT" });
    await expect(newRuleVersion(w.leadOps.actor, ctx(w.leadOps), v1)).rejects.toBeInstanceOf(ConflictError); // one working version
    await updateRule(w.leadOps.actor, ctx(w.leadOps), String(draft.id), updateRuleSchema.parse({ conditions: { outcomes: ["NOT_SOLD"] } }));
    await activateRule(w.leadOps.actor, ctx(w.leadOps), String(draft.id));
    const old = await getRule(w.leadOps.actor, v1);
    expect(old).toMatchObject({ status: "SUPERSEDED", version: 1, conditions: {} });
    const list = await listRules(w.leadOps.actor, listRulesQuerySchema.parse({ ruleKey: "versioned" }));
    expect(list.data.map((rule) => [rule.version, rule.status])).toEqual([[2, "ACTIVE"], [1, "SUPERSEDED"]]);
  });

  it("an active rule's content is immutable in the database (approval stays bound to what was approved)", async () => {
    const active = await makeActiveRule(w, {});
    await expect(withTenant(w.tenantId, (tx) => tx.recoveryRule.update({ where: { id: active }, data: { actions: [{ type: "recommend", code: "call_customer" }] } }))).rejects.toThrow();
  });

  it("deactivate stops a rule; it cannot be deactivated twice", async () => {
    const active = await makeActiveRule(w, {});
    expect(await deactivateRule(w.leadOps.actor, ctx(w.leadOps), active)).toMatchObject({ status: "INACTIVE" });
    await expect(deactivateRule(w.leadOps.actor, ctx(w.leadOps), active)).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });
});

describe("visibility", () => {
  it("Lead Ops sees rules in their unit only; another unit's rule is a 404", async () => {
    const mine = String((await create(w.leadOps)).id);
    const theirs = String((await create(w.ceo, { orgUnitId: w.units.cityB })).id);
    const ids = (await listRules(w.leadOps.actor, listRulesQuerySchema.parse({ latestOnly: "false", limit: 100 }))).data.map((rule) => rule.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    await expect(getRule(w.leadOps.actor, theirs)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("dry run (§9.6 testable)", () => {
  it("explains a match without writing anything", async () => {
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId, { run: false, quotedAmountMinor: 200_000 });
    const before = await withTenant(w.tenantId, async (tx) => ({ runs: await tx.recoveryRuleRun.count({ where: { tenantId: w.tenantId } }), cases: await tx.leadRecoveryCase.count({ where: { tenantId: w.tenantId } }) }));
    const result = await dryRunRule(
      w.leadOps.actor,
      dryRunSchema.parse({ jobOutcomeId: outcomeId, definition: { conditions: { outcomes: ["NOT_SOLD"], minValueMinor: 100_000 }, actions: [{ type: "create_case" }, { type: "notify", audience: "lead_operations" }] } }),
    );
    expect(result).toMatchObject({ matched: true, wouldFire: true, highImpact: true, stored: false, existingCaseId: null });
    expect(result.checks).toHaveLength(2);
    expect(result).toHaveProperty("presence.status", "UNKNOWN");
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude/i);

    const miss = await dryRunRule(w.leadOps.actor, dryRunSchema.parse({ jobOutcomeId: outcomeId, definition: { conditions: { minValueMinor: 900_000 }, actions: [{ type: "create_case" }] } }));
    expect(miss).toMatchObject({ matched: false, wouldFire: false, skippedReason: "conditions_not_met", actions: [] });

    const what = await dryRunRule(w.leadOps.actor, dryRunSchema.parse({ jobOutcomeId: outcomeId, presence: "LEFT_LOCATION", definition: { conditions: { presence: ["LEFT_LOCATION"] }, actions: [{ type: "create_case" }] } }));
    expect(what).toMatchObject({ matched: true, presence: { overridden: true } });

    const after = await withTenant(w.tenantId, async (tx) => ({ runs: await tx.recoveryRuleRun.count({ where: { tenantId: w.tenantId } }), cases: await tx.leadRecoveryCase.count({ where: { tenantId: w.tenantId } }) }));
    expect(after).toEqual(before);
  });

  it("tests a stored rule, refuses a discount definition and an outcome outside the caller's scope", async () => {
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId, { run: false });
    const rule = await makeActiveRule(w, { conditions: { outcomes: ["NOT_SOLD"] } });
    expect(await dryRunRule(w.leadOps.actor, dryRunSchema.parse({ jobOutcomeId: outcomeId, ruleId: rule }))).toMatchObject({ matched: true });
    await expect(dryRunRule(w.leadOps.actor, dryRunSchema.parse({ jobOutcomeId: outcomeId, definition: { actions: [{ type: "give_discount" }] } }))).rejects.toBeInstanceOf(ValidationError);
    await expect(dryRunRule(w.leadOpsB.actor, dryRunSchema.parse({ jobOutcomeId: outcomeId, ruleId: rule }))).rejects.toBeInstanceOf(NotFoundError);
    expect(() => dryRunSchema.parse({ jobOutcomeId: outcomeId })).toThrow();
  });
});
