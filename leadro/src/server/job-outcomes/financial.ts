import { canInTx, type AccessDecision, type ResourceRef } from "@/server/authz";
import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * The ONE answer to "may this caller see or send outcome money?": the opt-in `financial` field set of `job_outcomes`
 * (amounts, currency, payment status and method). Every module that shows or accepts such a value asks here.
 */
export const decisionHoldsFinancial = (decision: Pick<AccessDecision, "allowed" | "fieldSets">): boolean =>
  decision.allowed && decision.fieldSets.includes("financial");

/** Does the caller's `job_outcomes.view` grant over the job (`ref`) include the financial set? */
export async function holdsOutcomeFinancialSet(tx: TenantTx, actor: Actor, ref: ResourceRef): Promise<boolean> {
  return decisionHoldsFinancial(await canInTx(tx, actor, "job_outcomes.view", ref));
}
