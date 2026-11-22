import { describe, expect, it } from "vitest";
import { CATALOGS, SUPPORTED_LOCALES } from "@/lib/i18n";
import { PERMISSION_ACTIONS } from "@/server/authz";
import { ORG_UNIT_TYPES } from "@/lib/org-hierarchy";

/**
 * `npm run i18n:check` proves the three catalogs have the same keys, but it cannot see keys built
 * at runtime (`t(`ADMIN.EMPLOYEE_STATUS_${status}`)`). This lists every family the admin screens
 * build dynamically and checks each member exists in en-US, es-US AND he-IL.
 */
const families: Record<string, readonly string[]> = {
  "ADMIN.EMPLOYEE_STATUS_": ["ACTIVE", "ON_LEAVE", "TERMINATED"],
  "ADMIN.USER_STATUS_": ["INVITED", "ACTIVE", "LOCKED", "DEACTIVATED"],
  "ADMIN.INVITATION_STATE_": ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"],
  "ADMIN.ASSIGNMENT_KIND_": ["PRIMARY", "SECONDARY", "TEMPORARY"],
  "ADMIN.ASSIGNMENT_KIND_SHORT_": ["PRIMARY", "SECONDARY", "TEMPORARY"],
  "ADMIN.ASSIGNMENT_STATE_": ["ACTIVE", "SCHEDULED", "NOT_YET_EFFECTIVE", "EXPIRED", "REVOKED", "ROLE_INACTIVE"],
  "ADMIN.SCOPE_TYPE_": ["ORG_UNIT", "LEGAL_ENTITY", "TENANT", "OWN", "ASSIGNED"],
  "ADMIN.WEEKDAY_": ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
  "ADMIN.WHY_REASON_": ["GRANTED", "USER_NOT_ACTIVE", "UNKNOWN_PERMISSION", "NO_PERMISSION", "CONDITION_NOT_MET", "NO_SCOPE", "OUT_OF_SCOPE", "RESOURCE_NOT_FOUND"],
  "ORG_UNIT_TYPE.": ORG_UNIT_TYPES,
  "PERMISSION_ACTION.": PERMISSION_ACTIONS,
};

describe("dynamically built admin message keys", () => {
  for (const [prefix, members] of Object.entries(families)) {
    it(`${prefix}* exists in every catalog`, () => {
      for (const locale of SUPPORTED_LOCALES) {
        for (const member of members) expect(CATALOGS[locale].messages[`${prefix}${member}`], `${locale} ${prefix}${member}`).toBeTruthy();
      }
    });
  }
});
