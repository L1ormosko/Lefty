import type { Prisma } from "@prisma/client";
import { baseFieldMap, projectFields, type FieldMap } from "@/server/authz";

/**
 * What the approvals API returns. The amount and the `details` snapshot are the request's money: they are shown to the
 * requester and to people who hold the policy's `approverPermission` over the request (the people with authority over that
 * money). Someone who reaches the request only through `approvals.manage` (to oversee or cancel it) sees its status,
 * subject and people, not the amount (`moneyRedacted: true`). Anything not listed is dropped (fail closed).
 */
const AMOUNT_FIELD_SET = "amount";

export const APPROVAL_REQUEST_FIELD_MAP: FieldMap = {
  ...baseFieldMap([
    "id",
    "subjectType",
    "subjectId",
    "status",
    "policyId",
    "policyCode",
    "policyVersion",
    "requiredApprovals",
    "approverPermission",
    "jobId",
    "customerId",
    "orgUnitId",
    "reason",
    "requestedById",
    "excludedApproverIds",
    "requestedAt",
    "expiresAt",
    "decidedAt",
    "cancelledAt",
    "cancelledById",
    "cancelReason",
    "approvalCount",
    "decisions",
    "viewer",
    "moneyRedacted",
  ]),
  amountMinor: AMOUNT_FIELD_SET,
  currency: AMOUNT_FIELD_SET,
  details: AMOUNT_FIELD_SET,
};

export const approvalRequestRowSelect = {
  id: true,
  tenantId: true,
  subjectType: true,
  subjectId: true,
  policyId: true,
  policyCode: true,
  policyVersion: true,
  requiredApprovals: true,
  approverPermission: true,
  status: true,
  amountMinor: true,
  currency: true,
  jobId: true,
  customerId: true,
  orgUnitId: true,
  reason: true,
  details: true,
  requestedById: true,
  excludedApproverIds: true,
  requestedAt: true,
  expiresAt: true,
  decidedAt: true,
  cancelledAt: true,
  cancelledById: true,
  cancelReason: true,
  decisions: {
    select: { deciderId: true, decision: true, comment: true, decidedAt: true },
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.ApprovalRequestSelect;

export type ApprovalRequestRow = Prisma.ApprovalRequestGetPayload<{ select: typeof approvalRequestRowSelect }>;

/** What the viewer may do with the request right now (computed by the service, never trusted from a client). */
export interface ApprovalViewerFacts {
  isRequester: boolean;
  canDecide: boolean;
  canCancel: boolean;
  myDecision: "APPROVE" | "REJECT" | null;
}

/** The projected API view of one request. `moneyVisible` decides whether amount, currency and details are included. */
export function approvalRequestView(row: ApprovalRequestRow, viewer: ApprovalViewerFacts, moneyVisible: boolean): Record<string, unknown> {
  const { tenantId: _tenantId, decisions, ...rest } = row;
  const record = {
    ...rest,
    approvalCount: decisions.filter((decision) => decision.decision === "APPROVE").length,
    decisions,
    viewer,
    moneyRedacted: !moneyVisible,
  };
  return projectFields(record, { allowed: true, fieldSets: moneyVisible ? ["base", AMOUNT_FIELD_SET] : ["base"] }, APPROVAL_REQUEST_FIELD_MAP);
}

export const APPROVAL_POLICY_FIELDS = {
  id: true,
  code: true,
  subjectType: true,
  name: true,
  version: true,
  active: true,
  currency: true,
  minAmountMinor: true,
  maxAmountMinor: true,
  requiredApprovals: true,
  approverPermission: true,
  expiresAfterHours: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ApprovalPolicySelect;

export type ApprovalPolicyRow = Prisma.ApprovalPolicyGetPayload<{ select: typeof APPROVAL_POLICY_FIELDS }>;
