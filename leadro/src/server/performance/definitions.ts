import type { Prisma } from "@prisma/client";
import { METRIC_KIND_CATALOG, METRIC_KINDS, normalizeMetricParams, type MetricKind, type MetricParams } from "@/lib/performance-formulas";
import { recordAudit, type AuditContextFields } from "@/server/audit";
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  conflictOnUniqueViolation,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { definitionVisibilityWhere, enforceConfigure, enforceViewCapability, lockDefinitionKey } from "./access";
import { definitionRowSelect, definitionView, type DefinitionRow } from "./fields";
import type { CreateDefinitionInput, CreateVersionInput, ListDefinitionsQuery, ReasonInput, UpdateDefinitionInput } from "./schemas";

/**
 * Versioned metric definitions (spec 10.2; contract in DECISIONS.md "Phase 5 Task 1", formulas in "Phase 5 Task 3").
 *
 * A key (e.g. `on_time_arrival`) has numbered versions of ONE kind. A version is edited only while DRAFT and while no value
 * was computed from it (a preview value must keep meaning what it meant); after that a change is a new version. At most one
 * open (DRAFT or PENDING_APPROVAL) version per key. Publishing goes through the approval engine (`publication.ts`).
 */

/** Audit fields for writes that may run without a person (approval expiry calls back with no context). */
export function performanceAuditFields(tenantId: string, ctx: RequestContext | null): AuditContextFields {
  return { tenantId, actorUserId: ctx?.actor?.userId ?? null, sourceApp: ctx?.actor ? ctx.sourceApp : "SYSTEM", correlationId: ctx?.correlationId };
}

/**
 * The kind's params, normalized (unknown keys refused, `breakdown` defaulted). Stored normalized so a version says exactly how
 * it is computed.
 * @throws ValidationError with one detail per problem (`field` = `params.<key>`, code `performance.invalid_params`).
 */
export function validatedParams(kind: MetricKind, raw: Record<string, unknown>): MetricParams {
  const result = normalizeMetricParams(kind, raw);
  if (result.ok) return result.params;
  throw new ValidationError({
    message: `The parameters do not fit ${kind}.`,
    field: `params.${result.problems[0]?.path ?? ""}`,
    details: result.problems.map((problem) => ({ field: `params.${problem.path}`, code: "performance.invalid_params", message: problem.message })),
  });
}

/** Stored without absent keys (no `breakdown: null` on TRAINING_PROGRESS), so the stored object re-validates as is. */
const asJson = (params: MetricParams): Prisma.InputJsonObject =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== undefined)) as Prisma.InputJsonObject;

/** A definition version by id (404 when missing). */
export async function loadDefinition(tx: TenantTx, tenantId: string, definitionId: string): Promise<DefinitionRow> {
  const row = await tx.performanceMetricDefinition.findFirst({ where: { id: definitionId, tenantId }, select: definitionRowSelect });
  if (!row) throw new NotFoundError();
  return row;
}

/** Refuses a second open version of a key (the caller holds the key lock). @throws ConflictError */
async function assertNoOpenVersion(tx: TenantTx, tenantId: string, key: string): Promise<void> {
  const open = await tx.performanceMetricDefinition.findFirst({ where: { tenantId, key, status: { in: ["DRAFT", "PENDING_APPROVAL"] } }, select: { id: true, version: true } });
  if (open) {
    throw new ConflictError({
      message: `Version ${open.version} of this metric is still open. Finish, withdraw or retire it first.`,
      details: [{ field: "key", code: "performance.open_version_exists", message: open.id }],
    });
  }
}

/**
 * `POST /performance/definitions`: version 1 of a new key, as DRAFT. Needs `performance.configure` at TENANT scope.
 * @throws ForbiddenError, ValidationError (params), ConflictError (key already used)
 */
export async function createDefinition(actor: Actor, ctx: RequestContext, input: CreateDefinitionInput): Promise<Record<string, unknown>> {
  return conflictOnUniqueViolation("A metric with this key already exists. Create a new version of it instead.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceConfigure(tx, actor);
      const params = validatedParams(input.kind, input.params);
      const existing = await tx.performanceMetricDefinition.findFirst({ where: { tenantId: actor.tenantId, key: input.key }, select: { id: true } });
      if (existing) throw new ConflictError({ message: "A metric with this key already exists. Create a new version of it instead.", details: [{ field: "key", code: "performance.key_taken", message: existing.id }] });
      const created = await tx.performanceMetricDefinition.create({
        data: {
          tenantId: actor.tenantId,
          key: input.key,
          version: 1,
          kind: input.kind,
          dimension: METRIC_KIND_CATALOG[input.kind].dimension,
          name: input.name,
          description: input.description ?? null,
          params: asJson(params),
          minSample: input.minSample,
          createdById: actor.userId,
        },
        select: definitionRowSelect,
      });
      await recordAudit(tx, {
        ...performanceAuditFields(actor.tenantId, ctx),
        action: "performance_metric_definition.create",
        targetType: "PerformanceMetricDefinition",
        targetId: created.id,
        newValue: { key: created.key, version: 1, kind: created.kind, dimension: created.dimension, params: created.params, minSample: created.minSample, status: "DRAFT" },
      });
      return definitionView(created);
    }),
  );
}

/**
 * `POST /performance/definitions/{id}/versions`: a new DRAFT version of the same key (number = highest + 1), copying the
 * source version and applying the given changes. The kind never changes. Needs `performance.configure` at TENANT scope.
 * @throws ForbiddenError, NotFoundError, ValidationError, ConflictError (an open version exists)
 */
export async function createDefinitionVersion(actor: Actor, ctx: RequestContext, definitionId: string, input: CreateVersionInput): Promise<Record<string, unknown>> {
  return conflictOnUniqueViolation("Another version of this metric was created at the same time. Reload and try again.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceConfigure(tx, actor);
      const source = await loadDefinition(tx, actor.tenantId, definitionId);
      await lockDefinitionKey(tx, actor.tenantId, source.key);
      await assertNoOpenVersion(tx, actor.tenantId, source.key);
      const kind = source.kind as MetricKind;
      const params = validatedParams(kind, (input.params ?? source.params) as Record<string, unknown>);
      const latest = await tx.performanceMetricDefinition.findFirst({ where: { tenantId: actor.tenantId, key: source.key }, orderBy: { version: "desc" }, select: { version: true } });
      const created = await tx.performanceMetricDefinition.create({
        data: {
          tenantId: actor.tenantId,
          key: source.key,
          version: (latest?.version ?? source.version) + 1,
          kind,
          dimension: source.dimension,
          name: input.name ?? source.name,
          description: input.description === undefined ? source.description : input.description,
          params: asJson(params),
          minSample: input.minSample ?? source.minSample,
          createdById: actor.userId,
        },
        select: definitionRowSelect,
      });
      await recordAudit(tx, {
        ...performanceAuditFields(actor.tenantId, ctx),
        action: "performance_metric_definition.create_version",
        targetType: "PerformanceMetricDefinition",
        targetId: created.id,
        newValue: { key: created.key, version: created.version, fromVersion: source.version, kind, params: created.params, minSample: created.minSample, status: "DRAFT" },
      });
      return definitionView(created);
    }),
  );
}

/**
 * `PATCH /performance/definitions/{id}`: edits a DRAFT version that has no computed value yet.
 * @throws ForbiddenError, NotFoundError, InvalidStateTransitionError (not DRAFT), ConflictError (values exist), ValidationError
 */
export async function updateDefinition(actor: Actor, ctx: RequestContext, definitionId: string, input: UpdateDefinitionInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceConfigure(tx, actor);
    const before = await loadDefinition(tx, actor.tenantId, definitionId);
    await lockDefinitionKey(tx, actor.tenantId, before.key);
    const current = await loadDefinition(tx, actor.tenantId, definitionId);
    if (current.status !== "DRAFT") throw new InvalidStateTransitionError({ message: `This version is ${current.status}; create a new version to change it.` });
    if (await tx.performanceMetricValue.findFirst({ where: { tenantId: actor.tenantId, definitionId }, select: { id: true } })) {
      throw new ConflictError({
        message: "Values were already computed from this version; retire it and create a new version to change it.",
        details: [{ field: "id", code: "performance.definition_has_values", message: "Create a new version." }],
      });
    }
    const data: Prisma.PerformanceMetricDefinitionUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.minSample !== undefined) data.minSample = input.minSample;
    if (input.params !== undefined) data.params = asJson(validatedParams(current.kind as MetricKind, input.params));
    const updated = await tx.performanceMetricDefinition.update({ where: { id: definitionId }, data, select: definitionRowSelect });
    await recordAudit(tx, {
      ...performanceAuditFields(actor.tenantId, ctx),
      action: "performance_metric_definition.update",
      targetType: "PerformanceMetricDefinition",
      targetId: definitionId,
      previousValue: { name: current.name, description: current.description, params: current.params, minSample: current.minSample },
      newValue: { name: updated.name, description: updated.description, params: updated.params, minSample: updated.minSample },
    });
    return definitionView(updated);
  });
}

/**
 * `POST /performance/definitions/{id}/retire`: PUBLISHED -> RETIRED (the metric stops being current; its values stay, with
 * their history) or DRAFT -> RETIRED (discard a draft). A pending version is withdrawn instead. Needs `performance.configure`.
 * @throws ForbiddenError, NotFoundError, InvalidStateTransitionError
 */
export async function retireDefinition(actor: Actor, ctx: RequestContext, definitionId: string, input: ReasonInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceConfigure(tx, actor);
    const before = await loadDefinition(tx, actor.tenantId, definitionId);
    await lockDefinitionKey(tx, actor.tenantId, before.key);
    const current = await loadDefinition(tx, actor.tenantId, definitionId);
    if (current.status !== "PUBLISHED" && current.status !== "DRAFT") {
      throw new InvalidStateTransitionError({ message: current.status === "PENDING_APPROVAL" ? "Withdraw the pending version instead." : "This version is already retired." });
    }
    const updated = await tx.performanceMetricDefinition.update({ where: { id: definitionId }, data: { status: "RETIRED", retiredAt: new Date() }, select: definitionRowSelect });
    await recordAudit(tx, {
      ...performanceAuditFields(actor.tenantId, ctx),
      action: "performance_metric_definition.retire",
      targetType: "PerformanceMetricDefinition",
      targetId: definitionId,
      previousValue: { status: current.status },
      newValue: { status: "RETIRED", key: current.key, version: current.version, by: current.status === "DRAFT" ? "discarded" : "retired" },
      reason: input.reason,
    });
    return definitionView(updated);
  });
}

/**
 * `GET /performance/definitions`: versions by key, newest version first. Needs `performance.view` (capability); without
 * `performance.configure` only versions that were published are listed.
 * @throws ForbiddenError
 */
export async function listDefinitions(actor: Actor, query: ListDefinitionsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceViewCapability(tx, actor);
    const visibility = await definitionVisibilityWhere(tx, actor);
    const filters: Prisma.PerformanceMetricDefinitionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.key ? { key: query.key } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const rows = await tx.performanceMetricDefinition.findMany({
      where: { tenantId: actor.tenantId, AND: [visibility, filters] },
      orderBy: [{ key: "asc" }, { version: "desc" }, { id: "asc" }],
      select: definitionRowSelect,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(definitionView), page: page.page };
  });
}

/** `GET /performance/definitions/{id}`: one version (404 when missing or not visible to the caller). @throws ForbiddenError, NotFoundError */
export async function getDefinition(actor: Actor, definitionId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceViewCapability(tx, actor);
    const visibility = await definitionVisibilityWhere(tx, actor);
    const row = await tx.performanceMetricDefinition.findFirst({ where: { id: definitionId, tenantId: actor.tenantId, AND: [visibility] }, select: definitionRowSelect });
    if (!row) throw new NotFoundError();
    return definitionView(row);
  });
}

/** `GET /performance/catalog`: the fixed kind catalog (dimension, evidence table, params, breakdown). Needs `performance.view`. */
export async function getMetricCatalog(actor: Actor): Promise<Record<string, unknown>[]> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceViewCapability(tx, actor);
    return METRIC_KINDS.map((kind) => {
      const spec = METRIC_KIND_CATALOG[kind];
      return {
        kind,
        dimension: spec.dimension,
        evidenceTable: spec.evidenceTable,
        numeratorKind: spec.numeratorKind,
        breakdowns: spec.jobBased ? ["JOB_TYPE", "JOB_CATEGORY"] : [],
        params: [...(spec.jobBased ? ["breakdown"] : []), ...spec.paramKeys],
      };
    });
  });
}
