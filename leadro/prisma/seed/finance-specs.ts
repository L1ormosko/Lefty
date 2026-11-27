/**
 * Development seed data for the Phase 4 financial core: a few materials with an approved first cost version and the
 * default approval policies. Amounts are DEMONSTRATION values in USD minor units, not a price list and not a formula.
 */

export interface MaterialSpec {
  code: string;
  name: string;
  unit: string;
  supplier: string;
  /** Unit cost in minor units (cents): version 1, effective from 2020-01-01 so seeded job usage falls inside it. */
  unitCostMinor: bigint;
}

export const MATERIAL_SPECS: MaterialSpec[] = [
  { code: "pvc-pipe-1in", name: "PVC pipe, 1 inch", unit: "m", supplier: "Demo Supply Co.", unitCostMinor: 425n },
  { code: "copper-fitting-15mm", name: "Copper fitting, 15 mm", unit: "each", supplier: "Demo Supply Co.", unitCostMinor: 310n },
  { code: "ptfe-tape", name: "PTFE thread tape", unit: "roll", supplier: "Demo Supply Co.", unitCostMinor: 95n },
  { code: "silicone-sealant", name: "Silicone sealant, 300 ml", unit: "each", supplier: "Demo Hardware Ltd.", unitCostMinor: 780n },
  { code: "wire-clip-pack", name: "Wire clips, pack of 50", unit: "pack", supplier: "Demo Hardware Ltd.", unitCostMinor: 520n },
];

export interface ApprovalPolicySpec {
  code: string;
  subjectType: "MATERIAL_COST_CHANGE" | "ADJUSTMENT" | "REFUND" | "CHARGEBACK_WRITE_OFF" | "HIGH_VALUE_DISCOUNT" | "PERFORMANCE_METRIC_DEFINITION";
  name: string;
  minAmountMinor: bigint;
  maxAmountMinor: bigint | null;
  requiredApprovals: 1 | 2;
  approverPermission: string;
  expiresAfterHours: number | null;
}

/**
 * The defaults every tenant starts with (editable by creating a new policy version). Tiers by amount: a small amount needs
 * one approval, a large one two different people. Material cost changes always need one approval (no amount involved).
 */
export const APPROVAL_POLICY_SPECS: ApprovalPolicySpec[] = [
  {
    code: "material_cost_change",
    subjectType: "MATERIAL_COST_CHANGE",
    name: "Material cost change",
    minAmountMinor: 0n,
    maxAmountMinor: null,
    requiredApprovals: 1,
    approverPermission: "materials.approve",
    expiresAfterHours: 168,
  },
  {
    code: "refund_standard",
    subjectType: "REFUND",
    name: "Refund up to 500.00",
    minAmountMinor: 0n,
    maxAmountMinor: 50_000n,
    requiredApprovals: 1,
    approverPermission: "finance_refunds.approve",
    expiresAfterHours: 72,
  },
  {
    code: "refund_high_value",
    subjectType: "REFUND",
    name: "Refund of 500.00 or more (dual approval)",
    minAmountMinor: 50_000n,
    maxAmountMinor: null,
    requiredApprovals: 2,
    approverPermission: "finance_refunds.approve",
    expiresAfterHours: 72,
  },
  {
    code: "adjustment_standard",
    subjectType: "ADJUSTMENT",
    name: "Adjustment up to 1,000.00",
    minAmountMinor: 0n,
    maxAmountMinor: 100_000n,
    requiredApprovals: 1,
    approverPermission: "finance_adjustments.approve",
    expiresAfterHours: 72,
  },
  {
    code: "adjustment_high_value",
    subjectType: "ADJUSTMENT",
    name: "Adjustment of 1,000.00 or more (dual approval)",
    minAmountMinor: 100_000n,
    maxAmountMinor: null,
    requiredApprovals: 2,
    approverPermission: "finance_adjustments.approve",
    expiresAfterHours: 72,
  },
  {
    code: "chargeback_write_off",
    subjectType: "CHARGEBACK_WRITE_OFF",
    name: "Chargeback write-off",
    minAmountMinor: 0n,
    maxAmountMinor: null,
    requiredApprovals: 2,
    approverPermission: "finance_chargebacks.approve",
    expiresAfterHours: 168,
  },
  {
    code: "high_value_discount",
    subjectType: "HIGH_VALUE_DISCOUNT",
    name: "High-value discount (1,000.00 or more)",
    minAmountMinor: 100_000n,
    maxAmountMinor: null,
    requiredApprovals: 1,
    approverPermission: "jobs.approve",
    expiresAfterHours: 72,
  },
  // Phase 5: publishing a performance metric definition version (spec 10.2). No amount: one approval by a holder of
  // `performance.publish` who is not the author (separation of duties, approval engine).
  {
    code: "performance_metric_publication",
    subjectType: "PERFORMANCE_METRIC_DEFINITION",
    name: "Performance metric publication",
    minAmountMinor: 0n,
    maxAmountMinor: null,
    requiredApprovals: 1,
    approverPermission: "performance.publish",
    expiresAfterHours: 336,
  },
  // Phase 7: activating a high-impact automation rule version (spec 15.2), activating an accounting mapping version (accounting
  // treatment is reviewed) and releasing a payroll export batch. One approval each, never by the author / preparer (engine).
  {
    code: "automation_rule_activation",
    subjectType: "AUTOMATION_RULE_VERSION",
    name: "High-impact automation rule activation",
    minAmountMinor: 0n,
    maxAmountMinor: null,
    requiredApprovals: 1,
    approverPermission: "automation.approve",
    expiresAfterHours: 336,
  },
  {
    code: "accounting_mapping_activation",
    subjectType: "ACCOUNTING_MAPPING",
    name: "Accounting mapping activation",
    minAmountMinor: 0n,
    maxAmountMinor: null,
    requiredApprovals: 1,
    approverPermission: "accounting_exports.approve",
    expiresAfterHours: 336,
  },
  {
    code: "payroll_export_release",
    subjectType: "PAYROLL_EXPORT",
    name: "Payroll export release",
    minAmountMinor: 0n,
    maxAmountMinor: null,
    requiredApprovals: 1,
    approverPermission: "payroll_exports.approve",
    expiresAfterHours: 168,
  },
];
