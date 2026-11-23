import type { Prisma } from "@prisma/client";
import { withTenant } from "../../src/server/db";
import {
  DEFAULT_FORM_FIELDS_BY_CATEGORY,
  EXAMPLE_RECOVERY_RULE,
  FALLBACK_FORM_FIELDS,
  LOST_REASONS,
} from "./field-specs";

export interface SeedFieldOperationsResult {
  lostReasons: number;
  completionForms: number;
  recoveryRules: number;
}

/**
 * Seeds the Phase 3 catalogs for ONE existing tenant: lost reasons (spec 9.2), one ACTIVE version-1
 * completion form per job type that has none (spec 8.6), and the example recovery rule (INACTIVE, spec 9.6).
 * Each part is idempotent on its own (existing rows are never touched), so it also fills tenants that
 * were seeded before Phase 3. Job types must already exist (run `seedOperationalData` first).
 */
export async function seedFieldOperationsData(tenantId: string): Promise<SeedFieldOperationsResult> {
  return withTenant(tenantId, async (tx) => {
    const result: SeedFieldOperationsResult = { lostReasons: 0, completionForms: 0, recoveryRules: 0 };

    // Lost reasons.
    if ((await tx.lostReason.count()) === 0) {
      for (const [index, reason] of LOST_REASONS.entries()) {
        await tx.lostReason.create({ data: { tenantId, ...reason, sortOrder: (index + 1) * 10 } });
        result.lostReasons += 1;
      }
    }

    // One default completion form per job type that has no form yet.
    const jobTypes = await tx.jobType.findMany({ select: { id: true, name: true, category: true } });
    const typesWithForm = new Set(
      (await tx.jobCompletionFormDefinition.findMany({ where: { jobTypeId: { not: null } }, select: { jobTypeId: true } })).map(
        (form) => form.jobTypeId,
      ),
    );
    for (const jobType of jobTypes) {
      if (typesWithForm.has(jobType.id)) continue;
      const fields = DEFAULT_FORM_FIELDS_BY_CATEGORY[jobType.category] ?? FALLBACK_FORM_FIELDS;
      await tx.jobCompletionFormDefinition.create({
        data: {
          tenantId,
          jobTypeId: jobType.id,
          version: 1,
          status: "ACTIVE",
          name: `${jobType.name} completion form`,
          schema: { fields } as unknown as Prisma.InputJsonValue,
          publishedAt: new Date(),
        },
      });
      result.completionForms += 1;
    }

    // The example recovery rule (needs the "price too high" reason).
    const rule = EXAMPLE_RECOVERY_RULE;
    const alreadySeeded = await tx.recoveryRule.findFirst({ where: { ruleKey: rule.ruleKey }, select: { id: true } });
    const reason = await tx.lostReason.findFirst({ where: { code: rule.lostReasonCode }, select: { id: true } });
    if (!alreadySeeded && reason) {
      await tx.recoveryRule.create({
        data: {
          tenantId,
          ruleKey: rule.ruleKey,
          version: 1,
          name: rule.name,
          description: rule.description,
          status: "INACTIVE",
          priority: rule.priority,
          trigger: rule.trigger,
          highImpact: true,
          cooldownMinutes: rule.cooldownMinutes,
          conditions: { outcomes: ["NOT_SOLD"], lostReasonIds: [reason.id], presence: ["AT_LOCATION"] },
          actions: [
            { type: "create_case", priority: "URGENT" },
            { type: "notify", audience: "lead_operations" },
            { type: "recommend", code: "call_customer" },
          ],
        },
      });
      result.recoveryRules += 1;
    }
    return result;
  });
}
