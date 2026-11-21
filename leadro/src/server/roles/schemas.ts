import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

const id = z.string().trim().min(1).max(64);
const roleName = z.string().trim().min(1).max(80);
const description = z.string().trim().min(1).max(500);

/** `{ fields?, includeFields?, set? }`; authz parses it strictly and rejects anything else. */
const conditions = z.record(z.string(), z.unknown()).optional();

export const grantSchema = z.object({ permission: z.string().trim().min(1).max(80), conditions }).strict();
export type GrantInput = z.infer<typeof grantSchema>;

const grantsSchema = z
  .array(grantSchema)
  .max(200)
  .refine((grants) => new Set(grants.map((grant) => grant.permission)).size === grants.length, "Each permission may appear once");

export const createRoleSchema = z
  .object({
    name: roleName,
    description: description.optional(),
    /** Forced on when any permission requires it (permissions.manage/assign, *.configure). */
    requiresMfa: z.boolean().optional(),
    permissions: grantsSchema,
  })
  .strict();
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const cloneRoleSchema = z.object({ name: roleName, description: description.optional() }).strict();
export type CloneRoleInput = z.infer<typeof cloneRoleSchema>;

export const updateRoleSchema = z
  .object({ name: roleName.optional(), description: description.nullish(), requiresMfa: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const replacePermissionsSchema = z.object({ permissions: grantsSchema, reason: description.optional() }).strict();
export type ReplacePermissionsInput = z.infer<typeof replacePermissionsSchema>;

export const archiveRoleSchema = z.object({ reason: description }).strict();
export type ArchiveRoleInput = z.infer<typeof archiveRoleSchema>;

export const listRolesQuerySchema = pageQuerySchema.extend({
  active: z.enum(["true", "false", "all"]).default("true"),
  search: z.string().trim().min(1).max(100).optional(),
});
export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;

const scopeSchema = z
  .object({
    type: z.enum(["TENANT", "LEGAL_ENTITY", "ORG_UNIT", "OWN", "ASSIGNED"]),
    legalEntityId: id.optional(),
    orgUnitId: id.optional(),
    includeDescendants: z.boolean().optional(),
  })
  .strict();

const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const grantRoleSchema = z
  .object({
    userId: id,
    roleId: id,
    /** At least one: an assignment without a scope would grant access to nothing. */
    scopes: z.array(scopeSchema).min(1).max(20),
    effectiveFrom: instant.optional(),
    /** Temporary access: stops counting at this instant. */
    effectiveTo: instant.optional(),
    reason: description,
  })
  .strict();
export type GrantRoleInput = z.infer<typeof grantRoleSchema>;

export const revokeAssignmentSchema = z.object({ reason: description }).strict();
export type RevokeAssignmentInput = z.infer<typeof revokeAssignmentSchema>;

export const listAssignmentsQuerySchema = pageQuerySchema.extend({
  userId: id.optional(),
  roleId: id.optional(),
  /** `active` (default): in effect now. `all`: also revoked, expired and scheduled ones (history). */
  state: z.enum(["active", "all"]).default("active"),
});
export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuerySchema>;

export const effectiveAccessQuerySchema = z.object({
  userId: id,
  /** Optional: also explain why this single permission is (not) granted. */
  permission: z.string().trim().min(1).max(80).optional(),
  employeeId: id.optional(),
  orgUnitId: id.optional(),
});
export type EffectiveAccessQuery = z.infer<typeof effectiveAccessQuerySchema>;
