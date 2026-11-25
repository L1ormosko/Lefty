import type { ApprovalSubjectType, Prisma } from "@prisma/client";
import { bandsOverlap, resolvePolicy, type ApprovalAmount, type PolicyResolution } from "@/lib/approval-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx, isPermissionKey } from "@/server/authz";
import { ConflictError, conflictOnUniqueViolation, InvalidStateTransitionError, NotFoundError, pageArgs, toPage, ValidationError, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { APPROVAL_POLICY_FIELDS, type ApprovalPolicyRow } from "./fields";
import type { CreatePolicyInput, DeactivatePolicyInput, ListPoliciesQuery } from "./schemas";

/**
 * Approval policies (§21.3, §11.5): which changes need approval, by whom, how many people, and for how long.
 *
 * A policy row never changes apart from `active` (database trigger `approval_policy_guard`). Changing one = posting the same
 * `code` again, which inserts `version + 1` and deactivates the previous version in the same transaction (partial unique
 * index: one active version per code). Requests snapshot the policy they were resolved with, so a change never affects a
 * request already made. Policies are tenant-level records: every write needs `approvals.configure` at TENANT scope.
 */

/** Resolves the policy for a change (see `resolvePolicy` in `src/lib/approval-rules.ts` for the rules). Inside the caller's tx. */
export async function resolveApprovalPolicyInTx(
  tx: TenantTx,
  tenantId: string,
  subjectType: ApprovalSubjectType,
  amount: ApprovalAmount | null,
): Promise<PolicyResolution<ApprovalPolicyRow>> {
  const active = await tx.approvalPolicy.findMany({ where: { tenantId, subjectType, active: true }, select: APPROVAL_POLICY_FIELDS, orderBy: { id: "asc" } });
  return resolvePolicy(active, amount);
}

export async function listPolicies(actor: Actor, query: ListPoliciesQuery): Promise<Page<ApprovalPolicyRow>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "approvals.configure", {});
    const where: Prisma.ApprovalPolicyWhereInput = {
      tenantId: actor.tenantId,
      ...(query.activeOnly === "true" ? { active: true } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.code ? { code: query.code } : {}),
    };
    const rows = await tx.approvalPolicy.findMany({
      where,
      select: APPROVAL_POLICY_FIELDS,
      orderBy: [{ subjectType: "asc" }, { currency: "asc" }, { minAmountMinor: "asc" }, { code: "asc" }, { version: "desc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}

async function lockPolicyCode(tx: TenantTx, tenantId: string, code: string): Promise<void> {
  // Serializes concurrent versions of one code (and the overlap check) without a row to lock for a brand-new code.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`approval-policy:${tenantId}:${code}`}))`;
}

/**
 * Creates a policy, or the next version of an existing code. Refuses an approver permission that is not an `.approve` key of
 * the catalog, a different subject type for an existing code, and a band that overlaps another active policy of the same
 * subject type and currency (resolution would be ambiguous).
 */
export async function createPolicy(actor: Actor, ctx: RequestContext, input: CreatePolicyInput): Promise<ApprovalPolicyRow> {
  return conflictOnUniqueViolation("This policy changed at the same time. Reload and try again.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "approvals.configure", {});
      if (!isPermissionKey(input.approverPermission)) {
        throw new ValidationError({ message: "The approver permission is not a known permission.", field: "approverPermission" });
      }
      await lockPolicyCode(tx, actor.tenantId, input.code);
      const latest = await tx.approvalPolicy.findFirst({
        where: { tenantId: actor.tenantId, code: input.code },
        orderBy: { version: "desc" },
        select: { id: true, version: true, subjectType: true, active: true },
      });
      if (latest && latest.subjectType !== input.subjectType) {
        throw new ValidationError({ message: `Policy ${input.code} is for ${latest.subjectType}; use another code.`, field: "subjectType" });
      }
      const others = await tx.approvalPolicy.findMany({
        where: { tenantId: actor.tenantId, subjectType: input.subjectType, active: true, code: { not: input.code } },
        select: { code: true, currency: true, minAmountMinor: true, maxAmountMinor: true },
      });
      const clash = others.find((other) => bandsOverlap(other, input));
      if (clash) throw new ConflictError({ message: `The amount band overlaps active policy ${clash.code}.` });

      const previous = latest?.active ? latest : null;
      if (previous) await tx.approvalPolicy.update({ where: { id: previous.id }, data: { active: false } });
      const created = await tx.approvalPolicy.create({
        data: {
          tenantId: actor.tenantId,
          code: input.code,
          subjectType: input.subjectType,
          name: input.name,
          version: (latest?.version ?? 0) + 1,
          currency: input.currency,
          minAmountMinor: input.minAmountMinor,
          maxAmountMinor: input.maxAmountMinor,
          requiredApprovals: input.requiredApprovals,
          approverPermission: input.approverPermission,
          expiresAfterHours: input.expiresAfterHours,
          createdById: actor.userId,
        },
        select: APPROVAL_POLICY_FIELDS,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: latest ? "approval_policy.new_version" : "approval_policy.create",
        targetType: "ApprovalPolicy",
        targetId: created.id,
        previousValue: previous ? { policyId: previous.id, version: previous.version } : undefined,
        newValue: {
          code: created.code,
          version: created.version,
          subjectType: created.subjectType,
          currency: created.currency,
          minAmountMinor: created.minAmountMinor,
          maxAmountMinor: created.maxAmountMinor,
          requiredApprovals: created.requiredApprovals,
          approverPermission: created.approverPermission,
          expiresAfterHours: created.expiresAfterHours,
        },
      });
      return created;
    }),
  );
}

/** Deactivates the active version of a policy (no new version): changes of that subject type in its band stop needing it. */
export async function deactivatePolicy(actor: Actor, ctx: RequestContext, policyId: string, input: DeactivatePolicyInput): Promise<ApprovalPolicyRow> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "approvals.configure", {});
    const row = await tx.approvalPolicy.findFirst({ where: { id: policyId, tenantId: actor.tenantId }, select: { id: true, code: true, active: true } });
    if (!row) throw new NotFoundError();
    await lockPolicyCode(tx, actor.tenantId, row.code);
    const current = await tx.approvalPolicy.findFirstOrThrow({ where: { id: policyId, tenantId: actor.tenantId }, select: { active: true } });
    if (!current.active) throw new InvalidStateTransitionError({ message: "This policy version is not active." });
    const updated = await tx.approvalPolicy.update({ where: { id: policyId }, data: { active: false }, select: APPROVAL_POLICY_FIELDS });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "approval_policy.deactivate",
      targetType: "ApprovalPolicy",
      targetId: policyId,
      previousValue: { active: true },
      newValue: { active: false, code: updated.code, version: updated.version },
      reason: input.reason,
    });
    return updated;
  });
}
