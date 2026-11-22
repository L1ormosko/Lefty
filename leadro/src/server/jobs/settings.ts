import {
  JOB_TRANSITIONS,
  effectiveDisabledTransitions,
  invalidDisabledTransitions,
  transitionKey,
} from "@/lib/job-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import type { UpdateWorkflowSettingsInput } from "./schemas";

/**
 * Tenant narrowing of the job lifecycle (§7.2 "the company may configure certain workflows, but
 * invalid transitions must remain blocked"). The only knob is a list of OPTIONAL transitions
 * ("FROM>TO") a tenant switched off, stored in `OperationsSettings.disabledJobTransitions`. Naming
 * anything else is refused on write and ignored on read (`effectiveDisabledTransitions`), so a tenant
 * can neither add a transition nor remove one the default path needs.
 */

/** The tenant's valid switched-off optional transitions (no settings row = nothing switched off). */
export async function loadDisabledTransitions(tx: TenantTx, tenantId: string): Promise<Set<string>> {
  const settings = await tx.operationsSettings.findUnique({ where: { tenantId }, select: { disabledJobTransitions: true } });
  return effectiveDisabledTransitions(settings?.disabledJobTransitions ?? []);
}

export interface WorkflowSettingsView {
  disabledTransitions: string[];
  /** Every transition of the machine, so a settings screen can list the switches. */
  transitions: Array<{ key: string; from: string; to: string; optional: boolean; enabled: boolean }>;
}

function settingsView(disabled: Set<string>): WorkflowSettingsView {
  return {
    disabledTransitions: [...disabled].sort(),
    transitions: JOB_TRANSITIONS.map((rule) => {
      const key = transitionKey(rule.from, rule.to);
      return { key, from: rule.from, to: rule.to, optional: rule.optional, enabled: !disabled.has(key) };
    }),
  };
}

/** The job workflow as configured for the tenant. Needs `job_types.view` (not sensitive: technicians see which steps exist). */
export async function getJobWorkflowSettings(actor: Actor): Promise<WorkflowSettingsView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "job_types.view");
    return settingsView(await loadDisabledTransitions(tx, actor.tenantId));
  });
}

/**
 * Replaces the list of switched-off optional transitions. Needs a tenant-wide `job_types.configure`
 * (which makes the role require MFA). Names that are not optional transitions are a `400` listing them.
 */
export async function updateJobWorkflowSettings(actor: Actor, ctx: RequestContext, input: UpdateWorkflowSettingsInput): Promise<WorkflowSettingsView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "job_types.configure", {});
    const invalid = invalidDisabledTransitions(input.disabledTransitions);
    if (invalid.length > 0) {
      throw new ValidationError({
        message: "Only optional transitions can be switched off.",
        field: "disabledTransitions",
        details: invalid.map((key) => ({ field: "disabledTransitions", code: "NOT_OPTIONAL", message: `"${key}" is not an optional transition.` })),
      });
    }
    const previous = await loadDisabledTransitions(tx, actor.tenantId);
    const next = effectiveDisabledTransitions(input.disabledTransitions);
    await tx.operationsSettings.upsert({
      where: { tenantId: actor.tenantId },
      create: { tenantId: actor.tenantId, disabledJobTransitions: [...next].sort(), updatedById: actor.userId },
      update: { disabledJobTransitions: [...next].sort(), updatedById: actor.userId },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "job.workflow_update",
      targetType: "OperationsSettings",
      targetId: actor.tenantId,
      previousValue: { disabledTransitions: [...previous].sort() },
      newValue: { disabledTransitions: [...next].sort() },
    });
    return settingsView(next);
  });
}
