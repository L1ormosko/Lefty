import { GET as currentRoute } from "@/app/api/v1/shifts/current/route";
import { POST as endOwnRoute } from "@/app/api/v1/shifts/end/route";
import { POST as endByIdRoute } from "@/app/api/v1/shifts/[id]/end/route";
import { POST as reviewRoute } from "@/app/api/v1/shifts/[id]/review/route";
import { GET as getRoute } from "@/app/api/v1/shifts/[id]/route";
import { GET as listRoute } from "@/app/api/v1/shifts/route";
import { POST as startRoute } from "@/app/api/v1/shifts/start/route";
import { withTenant } from "@/server/db";
import { call } from "../org/org-helpers";

export { buildFieldWorld, position } from "../location/fixtures";

export const start = (cookie: string, body: Record<string, unknown> = {}) => call(startRoute, "POST", "/x", { cookie, body });
export const endOwn = (cookie: string, body: Record<string, unknown> = {}) => call(endOwnRoute, "POST", "/x", { cookie, body });
export const endById = (cookie: string, id: string, body: Record<string, unknown> = {}) => call(endByIdRoute, "POST", "/x", { cookie, params: { id }, body });
export const review = (cookie: string, id: string, body: Record<string, unknown>) => call(reviewRoute, "POST", "/x", { cookie, params: { id }, body });
export const current = (cookie: string) => call(currentRoute, "GET", "/x", { cookie });
export const getShift = (cookie: string, id: string) => call(getRoute, "GET", "/x", { cookie, params: { id } });
export const listShifts = (cookie: string, query: Record<string, string> = {}) => call(listRoute, "GET", "/x", { cookie, query });

/** Ends any ACTIVE shift of the employee directly in the database, so each test starts from "off shift". */
export const clearActiveShifts = (tenantId: string, employeeId: string) =>
  withTenant(tenantId, (tx) => tx.shift.updateMany({ where: { tenantId, employeeId, status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date(), endRecordedAt: new Date() } }));

export const shiftEvents = (tenantId: string, shiftId: string) =>
  withTenant(tenantId, (tx) => tx.locationEvent.findMany({ where: { tenantId, shiftId }, orderBy: { serverTime: "asc" } }));
