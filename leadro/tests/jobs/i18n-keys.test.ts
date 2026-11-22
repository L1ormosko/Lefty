import { describe, expect, it } from "vitest";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { JOB_STATUSES } from "@/lib/job-lifecycle";
import { NOTIFICATION_EVENTS } from "@/server/notifications";

/** Every language-neutral value the jobs API returns has a label in all three catalogs (clients render by key). */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };
const expectedKeys = [
  ...JOB_STATUSES.map((status) => `JOB.STATUS.${status}`),
  ...["LOW", "NORMAL", "HIGH", "URGENT"].map((priority) => `JOB.PRIORITY.${priority}`),
  ...["LEAD_CONVERSION", "RECURRING_AGREEMENT", "MANUAL", "INTEGRATION", "CUSTOMER_FOLLOW_UP"].map((origin) => `JOB.ORIGIN.${origin}`),
  ...["MANUAL", "RECOMMENDATION_APPROVED", "RECOMMENDATION_MODIFIED", "OVERRIDE"].map((method) => `JOB.ASSIGNMENT_METHOD.${method}`),
  ...["DURATION_EXCEEDS_WINDOW", "SLOT_SHORTER_THAN_DURATION", "ASSIGNEE_ELIGIBILITY_CONFLICT"].map((code) => `JOB.WARNING.${code}`),
  // Event types are `job.<name>` or `dispatch.override`; the label key is JOB.EVENT.<NAME> (dots become underscores).
  ...["created", "assigned", "reassigned", "unassigned", "rescheduled", "updated", "priority_changed", "status_changed", "dispatch.override"].map(
    (type) => `JOB.EVENT.${type.replace(/^job\./, "").replace(".", "_").toUpperCase()}`,
  ),
  ...Object.entries(NOTIFICATION_EVENTS).filter(([type]) => type.startsWith("job.")).flatMap(([, event]) => [`${event.templateKey}.TITLE`, `${event.templateKey}.BODY`]),
];

describe("jobs catalog keys", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has every JOB.* label and job notification text`, () => {
      const missing = expectedKeys.filter((key) => typeof catalog[key] !== "string" || (catalog[key] as string).length === 0);
      expect(missing).toEqual([]);
    });
  }
});
