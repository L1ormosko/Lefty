import { randomUUID } from "node:crypto";
import { POST as arriveRoute } from "@/app/api/v1/jobs/[id]/arrive/route";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { GET as arrivalsRoute } from "@/app/api/v1/jobs/[id]/arrivals/route";
import { POST as verifyRoute } from "@/app/api/v1/jobs/[id]/arrivals/[arrivalId]/verify/route";
import { POST as navigationRoute } from "@/app/api/v1/jobs/[id]/navigation-opened/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { POST as startWorkRoute } from "@/app/api/v1/jobs/[id]/start-work/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { withTenant } from "@/server/db";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "../jobs/fixtures";
import { call } from "../org/org-helpers";

/** The address the arrival tests judge positions against (the jobs world's customer A address). */
export const SITE = { latitude: 40, longitude: -89 };

export const buildArrivalWorld = async (label: string): Promise<JobsWorld> => {
  const w = await buildJobsWorld(label);
  await setAddress(w, { latitude: SITE.latitude, longitude: SITE.longitude, geofenceRadiusM: null });
  return w;
};

export const setAddress = (w: JobsWorld, data: { latitude: number | null; longitude: number | null; geofenceRadiusM: number | null }) =>
  withTenant(w.tenantId, (tx) => tx.customerAddress.update({ where: { id: w.customerA.addressId }, data }));

/** A device position `northMeters` north of the site (1 degree of latitude is about 111.2 km). */
export const positionNear = (overrides: Record<string, unknown> = {}, northMeters = 20) => ({
  latitude: SITE.latitude + northMeters / 111_200,
  longitude: SITE.longitude,
  accuracyM: 10,
  deviceTime: new Date().toISOString(),
  ...overrides,
});

const post = (route: Parameters<typeof call>[0], cookie: string, id: string, body: Record<string, unknown> = {}) => call(route, "POST", "/x", { cookie, params: { id }, body });
export const arrive = (cookie: string, jobId: string, body: Record<string, unknown>) => post(arriveRoute, cookie, jobId, body);
export const startWork = (cookie: string, jobId: string, body: Record<string, unknown> = {}) => post(startWorkRoute, cookie, jobId, body);
export const navigationOpened = (cookie: string, jobId: string, body: Record<string, unknown> = {}) => post(navigationRoute, cookie, jobId, body);
export const verify = (cookie: string, jobId: string, arrivalId: string, body: Record<string, unknown>) =>
  call(verifyRoute, "POST", "/x", { cookie, params: { id: jobId, arrivalId }, body });
export const listArrivals = (cookie: string, jobId: string) => call(arrivalsRoute, "GET", "/x", { cookie, params: { id: jobId } });
export const move = (cookie: string, jobId: string, toStatus: string, reason?: string) => post(transitionRoute, cookie, jobId, reason ? { toStatus, reason } : { toStatus });

/** Gives the job a scheduled slot (a dispatcher's reschedule; an ASSIGNED / RESCHEDULED / CUSTOMER_UNAVAILABLE job becomes SCHEDULED). */
export async function scheduleJob(w: JobsWorld, jobId: string): Promise<void> {
  const start = Date.now() + 2 * 86_400_000;
  const scheduled = await call(rescheduleRoute, "POST", "/x", {
    cookie: w.cookie.dispatcher,
    params: { id: jobId },
    body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString() } },
  });
  if (scheduled.status !== 200) throw new Error(`schedule failed: ${scheduled.status}`);
}

/** A job assigned to techA1 and SCHEDULED, not yet on the way. */
export async function scheduledJobFor(w: JobsWorld): Promise<string> {
  const job = await createJobViaApi(w);
  const assigned = await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
  if (assigned.status !== 200) throw new Error(`assign failed: ${assigned.status}`);
  await scheduleJob(w, job.id);
  return job.id;
}

/** A job assigned to techA1, scheduled and marked EN_ROUTE by the technician: ready for "I have arrived". */
export async function enRouteJob(w: JobsWorld): Promise<string> {
  const jobId = await scheduledJobFor(w);
  const enRoute = await move(w.cookie.techA1, jobId, "EN_ROUTE");
  if (enRoute.status !== 200) throw new Error(`en route failed: ${enRoute.status}`);
  return jobId;
}

/** Pretends the job reached its current status `minutes` ago (offline tests need a past EN_ROUTE moment to arrive after). */
export const backdateStatus = (w: JobsWorld, jobId: string, minutes: number) =>
  withTenant(w.tenantId, (tx) => tx.job.update({ where: { id: jobId }, data: { statusChangedAt: new Date(Date.now() - minutes * 60_000) } }));

export const newClientEventId = (): string => randomUUID();

export const jobRow = (w: JobsWorld, jobId: string) =>
  withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: jobId }, select: { status: true, startedAt: true } }));

export const storedArrivals = (w: JobsWorld, jobId: string) =>
  withTenant(w.tenantId, (tx) => tx.arrivalVerification.findMany({ where: { tenantId: w.tenantId, jobId }, orderBy: { recordedAt: "asc" } }));

export const storedLocationEvents = (w: JobsWorld, jobId: string) =>
  withTenant(w.tenantId, (tx) => tx.locationEvent.findMany({ where: { tenantId: w.tenantId, jobId }, orderBy: { serverTime: "asc" } }));
