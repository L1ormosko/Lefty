import { z } from "zod";
import { currencyCodeSchema, moneyAmountSchema } from "@/lib/money";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the approvals API (`/api/v1/approvals/**`). */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);

export const APPROVAL_SUBJECT_TYPES = [
  "MATERIAL_COST_CHANGE", "ADJUSTMENT", "REFUND", "CHARGEBACK_WRITE_OFF", "HIGH_VALUE_DISCOUNT", "PERFORMANCE_METRIC_DEFINITION",
  // Phase 7 (registered with the approval engine by Tasks 3 and 5).
  "AUTOMATION_RULE_VERSION", "ACCOUNTING_MAPPING", "PAYROLL_EXPORT",
] as const;
export const APPROVAL_REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "EXPIRED"] as const;

export const approvalIdParams = z.object({ id });

/** A decision. A rejection must say why (the requester is told, and the audit keeps it). */
export const decideApprovalSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    comment: text(2000).optional(),
  })
  .strict()
  .refine((value) => value.decision === "APPROVE" || value.comment !== undefined, { message: "A rejection needs a comment.", path: ["comment"] });
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

export const cancelApprovalSchema = z.object({ reason: text(500) }).strict();
export type CancelApprovalInput = z.infer<typeof cancelApprovalSchema>;

/** The approver queue: pending, unexpired requests the caller can decide now, oldest first. */
export const approvalQueueQuerySchema = pageQuerySchema
  .extend({ subjectType: z.enum(APPROVAL_SUBJECT_TYPES).optional() });
export type ApprovalQueueQuery = z.infer<typeof approvalQueueQuerySchema>;

/** The caller's own requests, newest first. */
export const myApprovalsQuerySchema = pageQuerySchema
  .extend({ status: z.enum(APPROVAL_REQUEST_STATUSES).optional(), subjectType: z.enum(APPROVAL_SUBJECT_TYPES).optional() });
export type MyApprovalsQuery = z.infer<typeof myApprovalsQuerySchema>;

/** Every request in the caller's `approvals.manage` scope, newest first. */
export const listApprovalsQuerySchema = pageQuerySchema
  .extend({
    status: z.enum(APPROVAL_REQUEST_STATUSES).optional(),
    subjectType: z.enum(APPROVAL_SUBJECT_TYPES).optional(),
    subjectId: id.optional(),
  });
export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;

// ───────────── Policies ─────────────

/**
 * A policy, or a new version of one: posting an existing `code` creates `version + 1` and deactivates the old version
 * (same subject type required). Amount bands are in minor units of `currency`: `minAmountMinor <= amount < maxAmountMinor`.
 */
export const createPolicySchema = z
  .object({
    code: z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, "lower-case letters, digits, . _ -"),
    subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
    name: text(120),
    currency: currencyCodeSchema.default("USD"),
    minAmountMinor: moneyAmountSchema.default(0),
    maxAmountMinor: moneyAmountSchema.nullable().default(null),
    requiredApprovals: z.union([z.literal(1), z.literal(2)]).default(1),
    approverPermission: z.string().trim().regex(/^[a-z][a-z0-9_]*\.approve$/, "an approve permission key, e.g. finance_refunds.approve"),
    expiresAfterHours: z.number().int().min(1).max(24 * 365).nullable().default(null),
  })
  .strict()
  .refine((value) => value.maxAmountMinor === null || value.maxAmountMinor > value.minAmountMinor, {
    message: "maxAmountMinor must be greater than minAmountMinor.",
    path: ["maxAmountMinor"],
  });
export type CreatePolicyInput = z.infer<typeof createPolicySchema>;

export const listPoliciesQuerySchema = pageQuerySchema
  .extend({
    subjectType: z.enum(APPROVAL_SUBJECT_TYPES).optional(),
    code: z.string().trim().max(63).optional(),
    activeOnly: z.enum(["true", "false"]).default("true"),
  });
export type ListPoliciesQuery = z.infer<typeof listPoliciesQuerySchema>;

export const deactivatePolicySchema = z.object({ reason: text(500) }).strict();
export type DeactivatePolicyInput = z.infer<typeof deactivatePolicySchema>;
