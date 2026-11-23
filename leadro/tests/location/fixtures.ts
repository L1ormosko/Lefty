import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { GET as getEventRoute } from "@/app/api/v1/location-events/[id]/route";
import { GET as listRoute, POST as recordRoute } from "@/app/api/v1/location-events/route";
import { withTenant } from "@/server/db";
import { call } from "../org/org-helpers";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "../jobs/fixtures";

/** The jobs world (State S > City A > Team A1, City B) plus helpers for the field-operations tests. */
export const buildFieldWorld = (label: string): Promise<JobsWorld> => buildJobsWorld(label);

/** A fresh "repair" job assigned to techA1 (so it is theirs: ASSIGNED scope). */
export async function assignedJobFor(w: JobsWorld): Promise<string> {
  const job = await createJobViaApi(w);
  const assigned = await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
  if (assigned.status !== 200) throw new Error(`assign failed: ${assigned.status} ${JSON.stringify(assigned.json)}`);
  return job.id;
}

/** A device position taken just now (the device clock is the test clock). */
export const position = (overrides: Record<string, unknown> = {}) => ({
  latitude: 40.0,
  longitude: -89.0,
  accuracyM: 12.4,
  deviceTime: new Date().toISOString(),
  ...overrides,
});

export const record = (cookie: string, body: Record<string, unknown>) => call(recordRoute, "POST", "/x", { cookie, body });
export const listEvents = (cookie: string, query: Record<string, string> = {}) => call(listRoute, "GET", "/x", { cookie, query });
export const getEvent = (cookie: string, id: string) => call(getEventRoute, "GET", "/x", { cookie, params: { id } });

/** Raw rows (coordinates included) for assertions about what is STORED. */
export const storedEvents = (tenantId: string, where: Record<string, unknown>) =>
  withTenant(tenantId, (tx) => tx.locationEvent.findMany({ where: { tenantId, ...where }, orderBy: { serverTime: "asc" } }));
