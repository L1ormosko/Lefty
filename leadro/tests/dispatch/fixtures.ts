import { GET as candidatesRoute } from "@/app/api/v1/dispatch/jobs/[id]/candidates/route";
import { GET as listRoute, POST as generateRoute } from "@/app/api/v1/dispatch/jobs/[id]/recommendations/route";
import { POST as approveRoute } from "@/app/api/v1/dispatch/recommendations/[id]/approve/route";
import { POST as modifyRoute } from "@/app/api/v1/dispatch/recommendations/[id]/modify/route";
import { POST as rejectRoute } from "@/app/api/v1/dispatch/recommendations/[id]/reject/route";
import { GET as getRoute } from "@/app/api/v1/dispatch/recommendations/[id]/route";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/v1/dispatch/settings/route";
import { withTenant } from "@/server/db";
import { call } from "../org/org-helpers";
import { buildJobsWorld, type JobsWorld } from "../jobs/fixtures";

/**
 * The jobs world (State S > City A > Team A1, City B; techA1 and techA1Other are both eligible for the
 * "inspection" job type, only techA1 for "repair") with a place on the map for each person, so distances
 * are known: the job site (customer A's address), techA1 about 1 km away, techA1Other about 28 km away.
 */
export interface DispatchWorld extends JobsWorld {
  /** "inspection" jobs: both technicians are eligible. */
  inspectionBody: Record<string, unknown>;
}

const SITE = { latitude: 40.0, longitude: -89.0 };

export async function buildDispatchWorld(label: string): Promise<DispatchWorld> {
  const w = await buildJobsWorld(label);
  await withTenant(w.tenantId, async (tx) => {
    await tx.customerAddress.update({ where: { id: w.customerA.addressId }, data: { latitude: SITE.latitude, longitude: SITE.longitude, coordinateSource: "manual" } });
    // 0.009 degrees of latitude is about 1 km; 0.25 about 28 km.
    await tx.employee.update({ where: { id: w.techA1.employeeId as string }, data: { startLatitude: SITE.latitude + 0.009, startLongitude: SITE.longitude } });
    await tx.employee.update({ where: { id: w.techA1Other.employeeId as string }, data: { startLatitude: SITE.latitude + 0.25, startLongitude: SITE.longitude } });
  });
  return { ...w, inspectionBody: { jobTypeId: w.ids.reviewType } };
}

export const generate = (cookie: string, jobId: string) => call(generateRoute, "POST", "/x", { cookie, params: { id: jobId } });
export const listFor = (cookie: string, jobId: string) => call(listRoute, "GET", "/x", { cookie, params: { id: jobId } });
export const candidates = (cookie: string, jobId: string) => call(candidatesRoute, "GET", "/x", { cookie, params: { id: jobId } });
export const read = (cookie: string, id: string) => call(getRoute, "GET", "/x", { cookie, params: { id } });
export const approve = (cookie: string, id: string, body: Record<string, unknown> = {}) => call(approveRoute, "POST", "/x", { cookie, params: { id }, body });
export const modify = (cookie: string, id: string, body: Record<string, unknown>) => call(modifyRoute, "POST", "/x", { cookie, params: { id }, body });
export const reject = (cookie: string, id: string, body: Record<string, unknown>) => call(rejectRoute, "POST", "/x", { cookie, params: { id }, body });
export const getSettings = (cookie: string) => call(settingsGet, "GET", "/x", { cookie });
export const putSettings = (cookie: string, body: Record<string, unknown>) => call(settingsPut, "PUT", "/x", { cookie, body });
