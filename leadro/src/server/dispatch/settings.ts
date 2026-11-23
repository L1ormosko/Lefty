import type { DispatchMode } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ConflictError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { AVAILABLE_DISPATCH_MODES, DISPATCH_MODES, type UpdateDispatchSettingsInput } from "./schemas";

/**
 * The tenant's dispatch mode (§7.5). MANUAL (people choose; no recommendations) and AI_ASSISTED
 * (deterministic rule-based recommendations that a person approves) run in this phase. RULE_BASED_AUTO
 * and OPTIMIZATION are valid configuration values that are refused as "not available in this phase": a
 * tenant can never end up with automatic assignment by accident. No settings row = AI_ASSISTED (default).
 */

export interface DispatchSettingsView {
  mode: DispatchMode;
  modes: Array<{ mode: DispatchMode; available: boolean }>;
}

const isAvailable = (mode: DispatchMode): boolean => AVAILABLE_DISPATCH_MODES.includes(mode);

/** The configured mode, read inside the caller's transaction. */
export async function loadDispatchMode(tx: TenantTx, tenantId: string): Promise<DispatchMode> {
  const settings = await tx.operationsSettings.findUnique({ where: { tenantId }, select: { dispatchMode: true } });
  return settings?.dispatchMode ?? "AI_ASSISTED";
}

/**
 * Refuses to generate recommendations unless the mode produces them.
 * @throws ConflictError in MANUAL mode, and for a stored mode this phase cannot run (never silently falls back).
 */
export function assertRecommendationsAvailable(mode: DispatchMode): void {
  if (mode === "MANUAL") throw new ConflictError({ message: "Dispatch mode is MANUAL: recommendations are switched off. Assign the job by hand." });
  if (!isAvailable(mode)) throw new ConflictError({ message: `Dispatch mode ${mode} is not available in this phase.` });
}

function view(mode: DispatchMode): DispatchSettingsView {
  return { mode, modes: DISPATCH_MODES.map((entry) => ({ mode: entry, available: isAvailable(entry) })) };
}

/** The current mode and which modes can be chosen. Needs a tenant-wide `dispatch.view`. */
export async function getDispatchSettings(actor: Actor): Promise<DispatchSettingsView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "dispatch.view", {});
    return view(await loadDispatchMode(tx, actor.tenantId));
  });
}

/**
 * Changes the dispatch mode. Needs a tenant-wide `dispatch.manage`. A mode this phase cannot run is a
 * `400` (field `mode`, code NOT_AVAILABLE); the change is audited.
 */
export async function updateDispatchSettings(actor: Actor, ctx: RequestContext, input: UpdateDispatchSettingsInput): Promise<DispatchSettingsView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "dispatch.manage", {});
    if (!isAvailable(input.mode)) {
      throw new ValidationError({
        message: `Dispatch mode ${input.mode} is not available in this phase.`,
        field: "mode",
        details: [{ field: "mode", code: "NOT_AVAILABLE", message: "Not available in this phase." }],
      });
    }
    const previous = await loadDispatchMode(tx, actor.tenantId);
    await tx.operationsSettings.upsert({
      where: { tenantId: actor.tenantId },
      create: { tenantId: actor.tenantId, dispatchMode: input.mode, updatedById: actor.userId },
      update: { dispatchMode: input.mode, updatedById: actor.userId },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "dispatch.mode_update",
      targetType: "OperationsSettings",
      targetId: actor.tenantId,
      previousValue: { mode: previous },
      newValue: { mode: input.mode },
    });
    return view(input.mode);
  });
}
