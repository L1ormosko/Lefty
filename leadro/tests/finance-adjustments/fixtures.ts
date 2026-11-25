import { randomUUID } from "node:crypto";
import type { ApprovalSubjectType } from "@prisma/client";
import { POST as recordPaymentRoute } from "@/app/api/v1/finance/payments/route";
import { createPolicy, createPolicySchema, decideApprovalRequest } from "@/server/approvals";
import { withTenant } from "@/server/db";
import { registerFinanceAdjustments } from "@/server/finance-adjustments";
import { createPerson, grantTemplate, makeRole, type Person } from "../authz/fixtures";
import { buildFinanceWorld, idempotencyHeader, type FinanceWorld } from "../finance/fixtures";
import { call, contextFor, sessionCookie } from "../org/org-helpers";

/**
 * The refund / chargeback / adjustment tests' world: the finance world (Owner `ceo` and Finance Director `finance` at
 * TENANT, City A / City B managers, technicians, COO) plus `approver2`, a custom role holding only the three finance
 * approve permissions and `approvals.view` at TENANT scope (a second approver for dual approval and separation of duties).
 * The approval subjects are (re-)registered explicitly: other test files may have installed fake handlers on globalThis.
 */
export interface CorrectionsWorld extends FinanceWorld {
  approver2: Person;
  approver2Cookie: string;
  cooPerson: Person;
}

export async function buildCorrectionsWorld(label: string): Promise<CorrectionsWorld> {
  registerFinanceAdjustments();
  const w = await buildFinanceWorld(label);
  const approver2 = await createPerson(w.tenantId, "approver2", { withEmployee: false });
  const role = await makeRole(w.tenantId, "Finance approver", [
    { permission: "finance_refunds.approve" },
    { permission: "finance_adjustments.approve" },
    { permission: "finance_chargebacks.approve" },
    { permission: "approvals.view" },
  ]);
  await grantTemplate(w.tenantId, approver2, role, [{ type: "TENANT" }]);
  const cooPerson = await createPerson(w.tenantId, "coo-person", { withEmployee: false });
  await grantTemplate(w.tenantId, cooPerson, w.roles.COO, [{ type: "TENANT" }]);
  return { ...w, approver2, approver2Cookie: await sessionCookie(approver2, w.tenantId), cooPerson };
}

/** A RECEIVED manual payment on the job (cash), returns its id. */
export async function receivedPayment(w: FinanceWorld, jobId: string, amountMinor: number): Promise<string> {
  const response = await call(recordPaymentRoute, "POST", "/api/v1/finance/payments", {
    cookie: w.cookie.finance,
    body: { jobId, method: "CASH", amountMinor },
    headers: idempotencyHeader(),
  });
  if (response.status !== 201) throw new Error(`payment not recorded: ${JSON.stringify(response.json)}`);
  return response.json.data.payment.id as string;
}

const APPROVER_PERMISSION: Record<string, string> = {
  REFUND: "finance_refunds.approve",
  ADJUSTMENT: "finance_adjustments.approve",
  CHARGEBACK_WRITE_OFF: "finance_chargebacks.approve",
};

/** An active USD policy for the subject type (by the Finance Director). */
export async function addPolicy(
  w: FinanceWorld,
  subjectType: ApprovalSubjectType,
  options: { min?: number; max?: number | null; requiredApprovals?: 1 | 2 } = {},
): Promise<void> {
  await createPolicy(
    w.finance.actor,
    contextFor(w.finance.actor),
    createPolicySchema.parse({
      code: `${subjectType.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      subjectType,
      name: `${subjectType} test policy`,
      minAmountMinor: options.min ?? 0,
      maxAmountMinor: options.max ?? null,
      requiredApprovals: options.requiredApprovals ?? 1,
      approverPermission: APPROVER_PERMISSION[subjectType],
    }),
  );
}

export const approve = (person: Person, requestId: string) => decideApprovalRequest(person.actor, contextFor(person.actor), requestId, { decision: "APPROVE" });
export const reject = (person: Person, requestId: string, comment = "Not justified") =>
  decideApprovalRequest(person.actor, contextFor(person.actor), requestId, { decision: "REJECT", comment });

/** Every review flag of a job, oldest first. */
export const flagsOf = (w: FinanceWorld, jobId: string) =>
  withTenant(w.tenantId, (tx) => tx.financeReviewFlag.findMany({ where: { jobId }, orderBy: [{ raisedAt: "asc" }, { id: "asc" }] }));

export { idempotencyHeader };
