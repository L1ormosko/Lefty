import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas for the employees API. Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);

/** `YYYY-MM-DD` -> a Date at 00:00 UTC (what a Postgres `date` column stores). Rejects 2026-02-31. */
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .transform((value, ctx) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a real calendar date" });
      return z.NEVER;
    }
    return date;
  });

/** An ISO-8601 instant with an explicit offset (`2026-11-21T13:40:00Z`). */
export const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

const phone = z.string().trim().min(5).max(32).regex(/^[+0-9 ()\-.]+$/, "Digits, spaces and + ( ) - . only");
const email = z.string().trim().toLowerCase().email().max(254);

const employeeFields = {
  firstName: text(80),
  lastName: text(80),
  email: email.nullish(),
  phone: phone.nullish(),
  jobTitle: text(120).nullish(),
  employeeNumber: text(40).nullish(),
  /** The legal employer. Operational placement is a separate concept (assignments). */
  legalEntityId: id.nullish(),
  hireDate: dateOnly.nullish(),
};

export const createEmployeeSchema = z
  .object({
    ...employeeFields,
    /** Where the employee works from day one. Omit only if you hold a tenant-wide grant. */
    orgUnitId: id.nullish(),
  })
  .strict();
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/** `status` here only toggles ACTIVE <-> ON_LEAVE; leaving the company is `terminate`. */
export const updateEmployeeSchema = z
  .object({
    firstName: employeeFields.firstName.optional(),
    lastName: employeeFields.lastName.optional(),
    email: employeeFields.email,
    phone: employeeFields.phone,
    jobTitle: employeeFields.jobTitle,
    employeeNumber: employeeFields.employeeNumber,
    legalEntityId: employeeFields.legalEntityId,
    hireDate: employeeFields.hireDate,
    status: z.enum(["ACTIVE", "ON_LEAVE"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const terminateEmployeeSchema = z
  .object({ terminationDate: dateOnly, reason: text(500) })
  .strict();
export type TerminateEmployeeInput = z.infer<typeof terminateEmployeeSchema>;

export const listEmployeesQuerySchema = pageQuerySchema.extend({
  status: z.enum(["ACTIVE", "ON_LEAVE", "TERMINATED"]).optional(),
  /** Employees currently placed in exactly this unit. */
  orgUnitId: id.optional(),
  legalEntityId: id.optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;

export const assignEmployeeSchema = z
  .object({
    orgUnitId: id,
    kind: z.enum(["PRIMARY", "SECONDARY", "TEMPORARY"]).default("PRIMARY"),
    /** Defaults to now. May be in the future (scheduled transfer) but never before the current placement started. */
    effectiveFrom: instant.optional(),
    /** Required for TEMPORARY, optional for SECONDARY, not allowed for PRIMARY (a transfer closes it). */
    effectiveTo: instant.optional(),
    reason: text(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "TEMPORARY" && !value.effectiveTo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "A temporary assignment needs an end date" });
    }
    if (value.kind === "PRIMARY" && value.effectiveTo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "A primary placement has no end date; transfer or terminate instead" });
    }
  });
export type AssignEmployeeInput = z.infer<typeof assignEmployeeSchema>;

export const endAssignmentSchema = z
  .object({ effectiveTo: instant.optional(), reason: text(500).optional() })
  .strict();
export type EndAssignmentInput = z.infer<typeof endAssignmentSchema>;

export const orgUnitAtQuerySchema = z.object({ date: instant });

const scopeSchema = z
  .object({
    type: z.enum(["TENANT", "LEGAL_ENTITY", "ORG_UNIT", "OWN", "ASSIGNED"]),
    legalEntityId: id.optional(),
    orgUnitId: id.optional(),
    includeDescendants: z.boolean().optional(),
  })
  .strict();

/** Inviting an employee to create a login, optionally with a role and its MANDATORY data scope. */
export const inviteEmployeeSchema = z
  .object({ email: email.optional(), roleId: id.optional(), scope: scopeSchema.optional() })
  .strict()
  .superRefine((value, ctx) => {
    if (value.roleId && !value.scope) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "A role needs a data scope" });
    }
    if (value.scope && !value.roleId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roleId"], message: "A scope needs a role" });
    }
  });
export type InviteEmployeeInput = z.infer<typeof inviteEmployeeSchema>;
