import { describe, expect, it } from "vitest";
import {
  assertWritableFields,
  JOB_EXECUTION_FIELDS,
  JOB_FIELD_MAP,
  JOB_WRITE_ALLOWLISTS,
  LEAD_FIELD_MAP,
  LEAD_STATUS_FIELDS,
  LEAD_WRITE_ALLOWLISTS,
  ROLE_TEMPLATES,
  writableFields,
} from "@/server/authz";
import { ForbiddenError } from "@/server/core";

const decision = (...fieldSets: string[]) => ({ allowed: true, fieldSets });

describe("write allowlists", () => {
  it("only list real, non-sensitive columns of their record", () => {
    for (const field of LEAD_STATUS_FIELDS) expect(LEAD_FIELD_MAP[field], field).toBe("base");
    for (const field of JOB_EXECUTION_FIELDS) expect(JOB_FIELD_MAP[field], field).toBe("base");
  });

  it("cover exactly the tags the Technician templates name on their write grants", () => {
    const tag = (permission: string) => ROLE_TEMPLATES.find((t) => t.key === "TECHNICIAN")!.grants.find((g) => g.permission === permission)?.conditions?.fields;
    expect(Object.keys(LEAD_WRITE_ALLOWLISTS)).toEqual([tag("leads.edit")]);
    expect(Object.keys(JOB_WRITE_ALLOWLISTS)).toEqual([tag("jobs.edit")]);
  });
});

describe("assertWritableFields", () => {
  it("lets a {fields:'execution'} grant change execution fields only", () => {
    expect(() => assertWritableFields(decision("execution"), ["status", "completedAt"], JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS)).not.toThrow();
    for (const forbidden of ["scheduledStartAt", "priority", "quotedAmountMinor", "orgUnitId", "tenantId", "notAColumn"]) {
      expect(() => assertWritableFields(decision("execution"), ["status", forbidden], JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS), forbidden).toThrow(ForbiddenError);
    }
  });

  it("lets a {fields:'status'} grant change the lead status only", () => {
    expect(() => assertWritableFields(decision("status"), ["status"], LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS)).not.toThrow();
    expect(() => assertWritableFields(decision("status"), ["contactPhone"], LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS)).toThrow(ForbiddenError);
  });

  it("a plain grant writes every base field but not sensitive ones unless named", () => {
    expect(() => assertWritableFields(decision("base"), ["title", "priority", "scheduledStartAt"], JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS)).not.toThrow();
    expect(() => assertWritableFields(decision("base"), ["quotedAmountMinor"], JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS)).toThrow(ForbiddenError);
    expect(() => assertWritableFields(decision("base", "financial"), ["quotedAmountMinor"], JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS)).not.toThrow();
  });

  it("fails closed: denied decisions, unknown tags and empty allowlists write nothing", () => {
    expect(writableFields({ allowed: false, fieldSets: ["base"] }, JOB_FIELD_MAP).size).toBe(0);
    expect(writableFields(decision("surprise"), JOB_FIELD_MAP).size).toBe(0);
    expect(() => assertWritableFields(decision("execution"), ["status"], JOB_FIELD_MAP)).toThrow(ForbiddenError); // no allowlist given
    expect(() => assertWritableFields(decision("base"), [], JOB_FIELD_MAP)).not.toThrow();
  });
});
