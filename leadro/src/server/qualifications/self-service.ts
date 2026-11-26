import { z } from "zod";
import { pageArgs, pageQuerySchema, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { CREDENTIAL_TYPES } from "./schemas";
import { toQualificationView, type QualificationView } from "./views";

/**
 * Self-service (spec 5.11 "certification status", `GET /api/v1/me/qualifications`): the caller's OWN skills and credentials
 * in every status, with the catalog name. No module permission: the query is filtered on the caller's employee record (a
 * user without one sees nothing). The holder sees their own credential number in full (see `maskCredentialNumber`).
 * A read model only: it changes nothing the eligibility engine reads.
 */

export const ownQualificationsQuerySchema = pageQuerySchema
  .extend({
    kind: z.enum(["SKILL", ...CREDENTIAL_TYPES]).optional(),
    status: z.enum(["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "REVOKED"]).optional(),
  })
  .strict();
export type OwnQualificationsQuery = z.infer<typeof ownQualificationsQuerySchema>;

export type OwnQualificationView = QualificationView & {
  skill: { code: string; name: string } | null;
  certification: { code: string; name: string; type: string } | null;
};

/** `GET /me/qualifications`: the caller's qualifications, soonest expiry first (no expiry last). */
export async function listOwnQualifications(actor: Actor, query: OwnQualificationsQuery): Promise<Page<OwnQualificationView>> {
  const employeeId = actor.employeeId;
  if (!employeeId) return toPage([], query.limit);
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.employeeQualification.findMany({
      where: {
        tenantId: actor.tenantId,
        employeeId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      include: { skill: { select: { code: true, name: true } }, certification: { select: { code: true, name: true, type: true } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return {
      data: page.data.map(({ skill, certification, ...row }) => ({ ...toQualificationView(row, true), skill, certification })),
      page: page.page,
    };
  });
}
