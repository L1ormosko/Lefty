import type { Prisma } from "@prisma/client";
import { isHighImpact, validateRuleDefinition } from "@/lib/recovery-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, projectFields, resolveScope, withinScope } from "@/server/authz";
import { ConflictError, ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { assertRuleAccess, loadRuleRow, ruleResourceRef, ruleScopeColumns } from "./access";
import { RULE_FIELD_MAP, ruleRowSelect, ruleView, type RuleRow } from "./fields";
import type { CreateRuleInput, ListRulesQuery, RuleDecisionInput, UpdateRuleInput } from "./schemas";

/**
 * Recovery rules (§9.6): versioned, never edited once they leave DRAFT, activated only by the right person.
 *
 *   DRAFT --submit--> PENDING_APPROVAL --approve--> ACTIVE <--> INACTIVE      (high impact: a second person approves)
 *   DRAFT --activate--> ACTIVE                                                (not high impact: `recovery.manage` is enough)
 *   ACTIVE --new version activated--> SUPERSEDED
 *
 * `highImpact` is DERIVED from the actions (`isHighImpact`); the author cannot lower it. Activating a high-impact rule needs
 * `recovery.approve` over the rule AND a person other than its author (separation of duties, §21.3; the database refuses it
 * too). Editing a non-draft rule means `newVersion`: a new DRAFT row with version + 1 that supersedes the active one once
 * it is activated, so the rule that created a case stays reproducible by (ruleId, version).
 */

function parseDefinition(input: { trigger: string; conditions: unknown; actions: unknown }) {
  const result = validateRuleDefinition(input);
  if (!result.ok) {
    throw new ValidationError({ message: result.problems.map((problem) => `${problem.path}: ${problem.message}`).join("; "), field: result.problems[0]?.path });
  }
  return result.definition;
}

async function assertOrgUnit(tx: TenantTx, tenantId: string, orgUnitId: string): Promise<void> {
  const unit = await tx.orgUnit.findFirst({ where: { id: orgUnitId, tenantId, active: true }, select: { id: true } });
  if (!unit) throw new ValidationError({ message: "The organization unit does not exist or is not active.", field: "orgUnitId" });
}

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export async function createRule(actor: Actor, ctx: RequestContext, input: CreateRuleInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "recovery.manage", input.orgUnitId ? { orgUnitId: input.orgUnitId } : {});
    const definition = parseDefinition(input);
    if (input.orgUnitId) await assertOrgUnit(tx, actor.tenantId, input.orgUnitId);
    const existing = await tx.recoveryRule.findFirst({ where: { tenantId: actor.tenantId, ruleKey: input.ruleKey }, select: { id: true } });
    if (existing) throw new ConflictError({ message: "A rule with this key exists. Create a new version of it instead." });

    const created = await tx.recoveryRule.create({
      data: {
        tenantId: actor.tenantId,
        ruleKey: input.ruleKey,
        version: 1,
        name: input.name,
        description: input.description ?? null,
        priority: input.priority,
        trigger: definition.trigger,
        conditions: json(definition.conditions),
        actions: json(definition.actions),
        orgUnitId: input.orgUnitId ?? null,
        highImpact: isHighImpact(definition.actions),
        cooldownMinutes: input.cooldownMinutes,
        createdById: actor.userId,
      },
      select: ruleRowSelect,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery_rule.create",
      targetType: "RecoveryRule",
      targetId: created.id,
      newValue: { ruleKey: created.ruleKey, version: 1, highImpact: created.highImpact, orgUnitId: created.orgUnitId, actionTypes: definition.actions.map((action) => action.type) },
    });
    return projectFields(ruleView(created), { allowed: true, fieldSets: [] }, RULE_FIELD_MAP);
  });
}

/** Edits a DRAFT in place (name, content, scope). Anything else needs `newVersion`. */
export async function updateRule(actor: Actor, ctx: RequestContext, ruleId: string, input: UpdateRuleInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await assertRuleAccess(tx, actor, ruleId, "recovery.manage");
    await lockRule(tx, actor.tenantId, ruleId);
    const current = await loadRuleRow(tx, actor.tenantId, ruleId);
    if (!current) throw new NotFoundError();
    if (current.status !== "DRAFT") throw new InvalidStateTransitionError({ message: "Only a draft can be edited. Create a new version of the rule." });
    const definition = parseDefinition({ trigger: current.trigger, conditions: input.conditions ?? current.conditions, actions: input.actions ?? current.actions });
    const orgUnitId = input.orgUnitId === undefined ? current.orgUnitId : input.orgUnitId;
    if (orgUnitId && orgUnitId !== current.orgUnitId) {
      await enforceInTx(tx, actor, "recovery.manage", { orgUnitId });
      await assertOrgUnit(tx, actor.tenantId, orgUnitId);
    }
    const updated = await tx.recoveryRule.update({
      where: { id: row.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.cooldownMinutes !== undefined ? { cooldownMinutes: input.cooldownMinutes } : {}),
        orgUnitId,
        conditions: json(definition.conditions),
        actions: json(definition.actions),
        highImpact: isHighImpact(definition.actions),
      },
      select: ruleRowSelect,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery_rule.update",
      targetType: "RecoveryRule",
      targetId: ruleId,
      previousValue: { highImpact: current.highImpact, orgUnitId: current.orgUnitId },
      newValue: { highImpact: updated.highImpact, orgUnitId: updated.orgUnitId, changed: Object.keys(input) },
    });
    return projectFields(ruleView(updated), { allowed: true, fieldSets: [] }, RULE_FIELD_MAP);
  });
}

async function lockRule(tx: TenantTx, tenantId: string, ruleId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "RecoveryRule" WHERE id = ${ruleId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

/** Copies a rule into a new DRAFT version (version + 1) so it can be edited; only one working version exists at a time. */
export async function newRuleVersion(actor: Actor, ctx: RequestContext, ruleId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const source = await assertRuleAccess(tx, actor, ruleId, "recovery.manage");
    // Serialize concurrent version creation for the key through the source row.
    await lockRule(tx, actor.tenantId, ruleId);
    const latest = await tx.recoveryRule.findFirstOrThrow({ where: { tenantId: actor.tenantId, ruleKey: source.ruleKey }, orderBy: { version: "desc" }, select: { id: true, version: true, status: true } });
    if (latest.status === "DRAFT" || latest.status === "PENDING_APPROVAL") {
      throw new ConflictError({ message: `Version ${latest.version} of this rule is still ${latest.status}. Finish or discard it first.` });
    }
    const created = await tx.recoveryRule.create({
      data: {
        tenantId: actor.tenantId,
        ruleKey: source.ruleKey,
        version: latest.version + 1,
        name: source.name,
        description: source.description,
        priority: source.priority,
        trigger: source.trigger,
        conditions: json(source.conditions),
        actions: json(source.actions),
        orgUnitId: source.orgUnitId,
        highImpact: source.highImpact,
        cooldownMinutes: source.cooldownMinutes,
        createdById: actor.userId,
      },
      select: ruleRowSelect,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery_rule.new_version",
      targetType: "RecoveryRule",
      targetId: created.id,
      newValue: { ruleKey: created.ruleKey, version: created.version, basedOn: source.id },
    });
    return projectFields(ruleView(created), { allowed: true, fieldSets: [] }, RULE_FIELD_MAP);
  });
}

/** DRAFT -> PENDING_APPROVAL (high-impact rules; a rule that is not high impact is activated directly). */
export async function submitRule(actor: Actor, ctx: RequestContext, ruleId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertRuleAccess(tx, actor, ruleId, "recovery.manage");
    await lockRule(tx, actor.tenantId, ruleId);
    const current = await loadRuleRow(tx, actor.tenantId, ruleId);
    if (!current) throw new NotFoundError();
    if (current.status !== "DRAFT") throw new InvalidStateTransitionError({ message: "Only a draft can be submitted for approval." });
    if (!current.highImpact) throw new InvalidStateTransitionError({ message: "This rule is not high impact: activate it directly." });
    const updated = await tx.recoveryRule.update({ where: { id: ruleId }, data: { status: "PENDING_APPROVAL", submittedAt: new Date() }, select: ruleRowSelect });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "recovery_rule.submit", targetType: "RecoveryRule", targetId: ruleId, previousValue: { status: "DRAFT" }, newValue: { status: "PENDING_APPROVAL" } });
    return projectFields(ruleView(updated), { allowed: true, fieldSets: [] }, RULE_FIELD_MAP);
  });
}

/**
 * Activates a rule (DRAFT or INACTIVE, or PENDING_APPROVAL for high impact). A high-impact rule needs `recovery.approve`
 * from a person other than its author; any older ACTIVE version of the key becomes SUPERSEDED in the same transaction.
 */
export async function activateRule(actor: Actor, ctx: RequestContext, ruleId: string, input: RuleDecisionInput = {}): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await loadRuleRow(tx, actor.tenantId, ruleId);
    if (!row) throw new NotFoundError();
    // The permission depends on the rule: approving a high-impact rule is its own grant.
    const permission = row.highImpact ? "recovery.approve" : "recovery.manage";
    await assertRuleAccess(tx, actor, ruleId, permission);
    await lockRule(tx, actor.tenantId, ruleId);
    const current = await loadRuleRow(tx, actor.tenantId, ruleId);
    if (!current) throw new NotFoundError();
    if (current.status === "ACTIVE" || current.status === "SUPERSEDED") {
      throw new InvalidStateTransitionError({ message: `A ${current.status} rule cannot be activated.` });
    }
    if (current.highImpact) {
      if (current.status === "DRAFT") throw new InvalidStateTransitionError({ message: "A high-impact rule must be submitted for approval first." });
      // Separation of duties (§21.3): the author never approves their own rule.
      if (current.createdById === actor.userId) throw new ForbiddenError({ message: "A high-impact rule must be approved by someone other than its author." });
    }
    const now = new Date();
    // The newest version wins: the previously ACTIVE version of this key retires in the same transaction (one ACTIVE per key).
    await tx.recoveryRule.updateMany({ where: { tenantId: actor.tenantId, ruleKey: current.ruleKey, status: "ACTIVE", id: { not: ruleId } }, data: { status: "SUPERSEDED" } });
    const updated = await tx.recoveryRule.update({
      where: { id: ruleId },
      data: { status: "ACTIVE", activatedAt: now, ...(current.highImpact ? { approvedById: actor.userId, approvedAt: now } : {}) },
      select: ruleRowSelect,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: current.highImpact ? "recovery_rule.approve" : "recovery_rule.activate",
      targetType: "RecoveryRule",
      targetId: ruleId,
      previousValue: { status: current.status },
      newValue: { status: "ACTIVE", ruleKey: current.ruleKey, version: current.version, highImpact: current.highImpact, createdById: current.createdById },
      reason: input.reason,
    });
    return projectFields(ruleView(updated), { allowed: true, fieldSets: [] }, RULE_FIELD_MAP);
  });
}

/** ACTIVE -> INACTIVE (stops evaluating, cases already created stay), or PENDING_APPROVAL -> INACTIVE (a rejection with a reason). */
export async function deactivateRule(actor: Actor, ctx: RequestContext, ruleId: string, input: RuleDecisionInput = {}): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await loadRuleRow(tx, actor.tenantId, ruleId);
    if (!row) throw new NotFoundError();
    await assertRuleAccess(tx, actor, ruleId, row.status === "PENDING_APPROVAL" ? "recovery.approve" : "recovery.manage");
    await lockRule(tx, actor.tenantId, ruleId);
    const current = await loadRuleRow(tx, actor.tenantId, ruleId);
    if (!current) throw new NotFoundError();
    if (current.status !== "ACTIVE" && current.status !== "PENDING_APPROVAL") {
      throw new InvalidStateTransitionError({ message: `A ${current.status} rule cannot be deactivated.` });
    }
    const updated = await tx.recoveryRule.update({ where: { id: ruleId }, data: { status: "INACTIVE" }, select: ruleRowSelect });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: current.status === "PENDING_APPROVAL" ? "recovery_rule.reject" : "recovery_rule.deactivate",
      targetType: "RecoveryRule",
      targetId: ruleId,
      previousValue: { status: current.status },
      newValue: { status: "INACTIVE" },
      reason: input.reason,
    });
    return projectFields(ruleView(updated), { allowed: true, fieldSets: [] }, RULE_FIELD_MAP);
  });
}

export async function getRule(actor: Actor, ruleId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await assertRuleAccess(tx, actor, ruleId, "recovery.view");
    return projectFields(ruleView(row), { allowed: true, fieldSets: [] }, RULE_FIELD_MAP);
  });
}

/** Rules in the caller's scope, newest version of each key by default, in evaluation order. */
export async function listRules(actor: Actor, query: ListRulesQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "recovery.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "recovery.view", now);
    const scoped = buildScopeWhere(scope, ruleScopeColumns, now);
    const filters: Prisma.RecoveryRuleWhereInput[] = [
      ...(query.status ? [{ status: query.status }] : []),
      ...(query.ruleKey ? [{ ruleKey: query.ruleKey }] : []),
    ];
    let rows = await tx.recoveryRule.findMany({
      where: withinScope(scoped, { tenantId: actor.tenantId, AND: filters }),
      select: ruleRowSelect,
      orderBy: [{ priority: "asc" }, { ruleKey: "asc" }, { version: "desc" }],
      ...pageArgs(query),
    });
    if (query.latestOnly === "true" && !query.ruleKey) {
      const seen = new Set<string>();
      rows = rows.filter((row) => (seen.has(row.ruleKey) ? false : (seen.add(row.ruleKey), true)));
    }
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => projectFields(ruleView(row), { allowed: true, fieldSets: [] }, RULE_FIELD_MAP)), page: page.page };
  });
}
