import { randomUUID } from "node:crypto";
import type { ApprovalSubjectType } from "@prisma/client";
import {
  createApprovalRequestInTx,
  createPolicy,
  createPolicySchema,
  registerApprovalSubject,
  type ApprovalOutcomeEvent,
  type CreateApprovalRequestResult,
} from "@/server/approvals";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, grantTemplate, makeRole, type Person, type World } from "../authz/fixtures";
import { contextFor } from "../org/org-helpers";

/**
 * A tenant for the approval tests: the standard authz world (Owner and Finance Director approve refunds tenant-wide, the
 * City A manager requests them and sees the queue of City A) plus
 *  - `coo`: the COO template (approvals.view + manage, no refund approval: an overseer who never sees amounts);
 *  - `approverB`: a custom role with `finance_refunds.approve` + `approvals.view` limited to City B (out of scope for City A);
 *  - two refund policies in USD: below 500.00 one approval (expires after 24 h), from 500.00 two approvals.
 * Subjects are fake records owned by a test handler (`subjects`: id -> org unit) that records every callback in `calls`.
 */
export interface ApprovalWorld extends World {
  coo: Person;
  approverB: Person;
  subjects: Map<string, string | null>;
  calls: ApprovalOutcomeEvent[];
  /** When set, the next `onApproved` throws (to prove the decision rolls back with it). */
  failNextApproval: { value: boolean };
}

export function installTestSubjects(w: Pick<ApprovalWorld, "subjects" | "calls" | "failNextApproval">, types: ApprovalSubjectType[] = ["REFUND", "ADJUSTMENT"]): void {
  for (const subjectType of types) {
    registerApprovalSubject(subjectType, {
      async resolveResource(_tx, _tenantId, subjectId) {
        if (!w.subjects.has(subjectId)) return null;
        const orgUnitId = w.subjects.get(subjectId);
        return orgUnitId ? { orgUnitId } : {};
      },
      async onApproved(_tx, event) {
        if (w.failNextApproval.value) {
          w.failNextApproval.value = false;
          throw new Error("subject refused the approval");
        }
        w.calls.push(event);
      },
      async onRejected(_tx, event) {
        w.calls.push(event);
      },
    });
  }
}

export async function buildApprovalWorld(label: string): Promise<ApprovalWorld> {
  const w = await buildWorld(label);
  const coo = await createPerson(w.tenantId, "coo", { withEmployee: false });
  await grantTemplate(w.tenantId, coo, w.roles.COO, [{ type: "TENANT" }]);
  const approverB = await createPerson(w.tenantId, "approver-b", { orgUnitId: w.units.cityB, legalEntityId: w.legalEntityId });
  const roleB = await makeRole(w.tenantId, "Refund approver B", [{ permission: "finance_refunds.approve" }, { permission: "approvals.view" }]);
  await grantTemplate(w.tenantId, approverB, roleB, [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }]);

  const ctx = contextFor(w.finance.actor);
  await createPolicy(w.finance.actor, ctx, createPolicySchema.parse({ code: "refund_small", subjectType: "REFUND", name: "Small refund", maxAmountMinor: 50_000, approverPermission: "finance_refunds.approve", expiresAfterHours: 24 }));
  await createPolicy(w.finance.actor, ctx, createPolicySchema.parse({ code: "refund_large", subjectType: "REFUND", name: "Large refund", minAmountMinor: 50_000, requiredApprovals: 2, approverPermission: "finance_refunds.approve" }));

  const world: ApprovalWorld = { ...w, coo, approverB, subjects: new Map(), calls: [], failNextApproval: { value: false } };
  installTestSubjects(world);
  return world;
}

/** A fresh fake subject in `orgUnitId` (default City A; null = tenant-level). */
export function newSubject(w: ApprovalWorld, orgUnitId: string | null = w.units.cityA): string {
  const id = `subject-${randomUUID()}`;
  w.subjects.set(id, orgUnitId);
  return id;
}

/** Opens a request as `requester` (null = the system) through the in-transaction API subject modules use. */
export async function requestApproval(
  w: ApprovalWorld,
  requester: Person | null,
  options: {
    subjectType?: ApprovalSubjectType;
    subjectId?: string;
    amountMinor?: bigint | null;
    currency?: string;
    excludedApproverIds?: string[];
    idempotencyKey?: string;
    details?: Record<string, unknown>;
    orgUnitId?: string | null;
  } = {},
): Promise<CreateApprovalRequestResult> {
  const subjectId = options.subjectId ?? newSubject(w, options.orgUnitId === undefined ? w.units.cityA : options.orgUnitId);
  const amountMinor = options.amountMinor === undefined ? 12_000n : options.amountMinor;
  return withTenant(w.tenantId, (tx) =>
    createApprovalRequestInTx(tx, requester ? contextFor(requester.actor) : null, {
      tenantId: w.tenantId,
      subjectType: options.subjectType ?? "REFUND",
      subjectId,
      amount: amountMinor === null ? null : { amountMinor, currency: options.currency ?? "USD" },
      excludedApproverIds: options.excludedApproverIds,
      idempotencyKey: options.idempotencyKey,
      details: options.details,
      reason: "Customer was double charged",
    }),
  );
}

/** `requestApproval` that must open a request; returns its id. */
export async function openRequest(w: ApprovalWorld, requester: Person | null, options: Parameters<typeof requestApproval>[2] = {}): Promise<string> {
  const result = await requestApproval(w, requester, options);
  if (!result.required) throw new Error("expected an approval request");
  return result.request.id;
}
