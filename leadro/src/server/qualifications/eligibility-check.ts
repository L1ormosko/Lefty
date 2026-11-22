import type { EligibilityFailure, EligibilityResult } from "@/lib/eligibility";
import type { TranslateFn } from "@/lib/i18n";
import { enforceInTx } from "@/server/authz";
import { NotFoundError, ValidationError, type Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import { isEligible, requirementsForJobType } from "./eligibility";
import type { EligibilityCheckInput } from "./schemas";
import { resolveWorkTimeZone } from "./time-zones";
import { assertBaseFields } from "./views";

/**
 * The permission-checked, API-facing eligibility check ("can Maria do a boiler repair in City A on
 * Monday 09:00-11:00?"). Needs `qualifications.view` over the employee, so a dispatcher can ask about
 * employees in their scope and nobody can probe a colleague's credentials outside it.
 *
 * Requirements come from the job type (plus extras), so it works before a job exists; the dispatch
 * engine calls `isEligible` / `evaluateCandidates` with a job's own requirements instead.
 */
export async function checkEligibilityAsActor(
  actor: Actor,
  input: EligibilityCheckInput,
): Promise<EligibilityResult & { employeeId: string; timeZone: string }> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const decision = await enforceInTx(tx, actor, "qualifications.view", { employeeId: input.employeeId });
    assertBaseFields(decision);

    // Unknown ids in the extras are a client mistake: say which field rather than silently ignoring them.
    const skillIds = input.extraSkills.map((skill) => skill.skillId);
    if (skillIds.length > 0) {
      const found = await tx.skill.count({ where: { tenantId: actor.tenantId, id: { in: skillIds } } });
      if (found !== new Set(skillIds).size) throw new ValidationError({ message: "Unknown skill.", field: "extraSkills" });
    }
    if (input.extraCertificationIds.length > 0) {
      const found = await tx.certification.count({ where: { tenantId: actor.tenantId, id: { in: input.extraCertificationIds } } });
      if (found !== new Set(input.extraCertificationIds).size) throw new ValidationError({ message: "Unknown certification.", field: "extraCertificationIds" });
    }
    if (input.orgUnitId && !(await tx.orgUnit.findFirst({ where: { id: input.orgUnitId, tenantId: actor.tenantId }, select: { id: true } }))) {
      throw new ValidationError({ message: "Unknown organization unit.", field: "orgUnitId" });
    }

    let requirements;
    try {
      requirements = await requirementsForJobType(tx, actor.tenantId, input.jobTypeId, {
        orgUnitId: input.orgUnitId,
        additional: { skills: input.extraSkills, certificationIds: input.extraCertificationIds },
      });
    } catch (error) {
      if (error instanceof NotFoundError) throw new ValidationError({ message: "Unknown job type.", field: "jobTypeId" });
      throw error;
    }

    const timeZone = input.timeZone ?? (await resolveWorkTimeZone(tx, actor.tenantId, { orgUnitId: input.orgUnitId }));
    const result = await isEligible(tx, actor.tenantId, input.employeeId, requirements, {
      at: new Date(),
      window: input.startsAt && input.endsAt ? { startsAt: input.startsAt, endsAt: input.endsAt } : null,
      timeZone,
    });
    return { employeeId: input.employeeId, timeZone, ...result };
  });
}

/**
 * Renders a failure for display with the viewer's translator: `QUALIFICATION.FAILURE.<code>` with the
 * failure's params, where a `kind` param is first translated through `QUALIFICATION.KIND.<kind>` so the
 * sentence reads naturally in every language ("Missing license: Electrical"). The API returns codes and
 * params only; this is for server-rendered screens, emails and notifications.
 */
export function renderEligibilityFailure(translate: TranslateFn, failure: EligibilityFailure): string {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(failure.params)) {
    // A catalog entry without a name falls back to its id; any other unknown value reads as a dash.
    const shown = value ?? (name === "name" ? (failure.params.id ?? "–") : "–");
    params[name] = name === "kind" && typeof shown === "string" ? translate(`QUALIFICATION.KIND.${shown}`) : shown;
  }
  return translate(`QUALIFICATION.FAILURE.${failure.code}`, params);
}
