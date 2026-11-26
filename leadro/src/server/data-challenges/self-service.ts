import { z } from "zod";
import { NotFoundError, pageArgs, pageQuerySchema, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { toDataChallengeView, type DataChallengeView } from "./read";
import { DATA_CHALLENGE_TARGET_TYPES } from "./schemas";

/**
 * Self-service (spec 10.4 "employees can challenge", 5.11, `/api/v1/me/data-challenges/*`): the caller reads the challenges
 * they raised about their own data, with the status, the reviewer and the resolution. No module permission: the query is
 * filtered on the caller's employee record (another person's challenge is a 404). Raising and withdrawing are
 * `POST /api/v1/data-challenges` and `POST /api/v1/data-challenges/{id}/withdraw` (also self-service).
 */

const STATUSES = ["OPEN", "UNDER_REVIEW", "UPHELD", "REJECTED", "WITHDRAWN"] as const;

export const ownDataChallengesQuerySchema = pageQuerySchema
  .extend({ status: z.enum(STATUSES).optional(), targetType: z.enum(DATA_CHALLENGE_TARGET_TYPES).optional() })
  .strict();
export type OwnDataChallengesQuery = z.infer<typeof ownDataChallengesQuerySchema>;

/** `GET /me/data-challenges`: the caller's challenges, newest first. */
export async function listOwnDataChallenges(actor: Actor, query: OwnDataChallengesQuery): Promise<Page<DataChallengeView>> {
  const employeeId = actor.employeeId;
  if (!employeeId) return toPage([], query.limit);
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.dataChallenge.findMany({
      where: {
        tenantId: actor.tenantId,
        employeeId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.targetType ? { targetType: query.targetType } : {}),
      },
      orderBy: [{ raisedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toDataChallengeView), page: page.page };
  });
}

/** `GET /me/data-challenges/{id}`: one of the caller's challenges (404 for anyone else's). */
export async function getOwnDataChallenge(actor: Actor, challengeId: string): Promise<DataChallengeView> {
  const employeeId = actor.employeeId;
  if (!employeeId) throw new NotFoundError();
  return withTenant(actor.tenantId, async (tx) => {
    const challenge = await tx.dataChallenge.findFirst({ where: { id: challengeId, tenantId: actor.tenantId, employeeId } });
    if (!challenge) throw new NotFoundError();
    return toDataChallengeView(challenge);
  });
}
