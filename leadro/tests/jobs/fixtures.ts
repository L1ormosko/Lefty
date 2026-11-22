import { POST as createJobRoute } from "@/app/api/v1/jobs/route";
import { withTenant } from "@/server/db";
import { buildWorld, type World } from "../authz/fixtures";
import { makeAddress, makeCustomer } from "../customers/fixtures";
import { call, sessionCookie } from "../org/org-helpers";

/**
 * A tenant for the jobs tests: the standard authz world (State S > City A > Team A1, City B, one person per
 * role template), plus a job-type catalog, customers with service addresses and equipped technicians.
 *
 *  - `techA1`       : fully eligible for "repair" (HVAC skill level 3, EPA license, job permission, City A territory)
 *  - `techA1Other`  : same, but WITHOUT the license: ineligible for "repair", eligible for "inspection"
 *  - `techB`        : no qualifications at all (City B)
 */
export interface JobsWorld extends World {
  cookie: Record<"dispatcher" | "ceo" | "cityManagerA" | "cityManagerB" | "techA1" | "techA1Other" | "techB" | "finance" | "hr", string>;
  ids: {
    hvac: string;
    epa: string;
    repairType: string;
    reviewType: string;
  };
  customerA: { id: string; addressId: string };
  customerB: { id: string; addressId: string };
  archivedCustomer: { id: string; addressId: string };
}

const DAY = 86_400_000;

async function qualify(w: World, employeeId: string, data: { skillId?: string; certificationId?: string; kind: "SKILL" | "LICENSE"; level?: number }): Promise<void> {
  await withTenant(w.tenantId, (tx) =>
    tx.employeeQualification.create({
      data: { tenantId: w.tenantId, employeeId, status: "VERIFIED", verifiedById: w.hr.userId, verifiedAt: new Date(), ...data },
    }),
  );
}

/** Job-category permission + City A territory for an employee (no availability rows: jobs without a window skip that check). */
async function authorize(w: World, employeeId: string, categories: string[]): Promise<void> {
  await withTenant(w.tenantId, async (tx) => {
    for (const category of categories) {
      await tx.employeeJobPermission.create({ data: { tenantId: w.tenantId, employeeId, category, effectiveFrom: new Date(Date.now() - 365 * DAY) } });
    }
    await tx.serviceTerritory.create({ data: { tenantId: w.tenantId, employeeId, orgUnitId: w.units.cityA, includeDescendants: true, effectiveFrom: new Date(Date.now() - 365 * DAY) } });
  });
}

export async function buildJobsWorld(label: string): Promise<JobsWorld> {
  const w = await buildWorld(label);
  const cookie = {
    dispatcher: await sessionCookie(w.dispatcher, w.tenantId),
    ceo: await sessionCookie(w.ceo, w.tenantId),
    cityManagerA: await sessionCookie(w.cityManagerA, w.tenantId),
    cityManagerB: await sessionCookie(w.cityManagerB, w.tenantId),
    techA1: await sessionCookie(w.techA1, w.tenantId),
    techA1Other: await sessionCookie(w.techA1Other, w.tenantId),
    techB: await sessionCookie(w.techB, w.tenantId),
    finance: await sessionCookie(w.finance, w.tenantId),
    hr: await sessionCookie(w.hr, w.tenantId),
  };

  const ids = await withTenant(w.tenantId, async (tx) => {
    const hvac = await tx.skill.create({ data: { tenantId: w.tenantId, code: "hvac", name: "HVAC" } });
    const epa = await tx.certification.create({ data: { tenantId: w.tenantId, code: "epa-608", name: "EPA 608", type: "LICENSE" } });
    const repairType = await tx.jobType.create({
      data: { tenantId: w.tenantId, code: "hvac-repair", name: "HVAC repair", category: "repair", defaultDurationMinutes: 120, defaultPriority: "HIGH" },
    });
    await tx.jobTypeSkill.create({ data: { tenantId: w.tenantId, jobTypeId: repairType.id, skillId: hvac.id, minLevel: 3 } });
    await tx.jobTypeCertification.create({ data: { tenantId: w.tenantId, jobTypeId: repairType.id, certificationId: epa.id } });
    const reviewType = await tx.jobType.create({
      data: { tenantId: w.tenantId, code: "inspection", name: "Inspection", category: "inspection", defaultDurationMinutes: 60, requiresReview: true },
    });
    return { hvac: hvac.id, epa: epa.id, repairType: repairType.id, reviewType: reviewType.id };
  });

  await qualify(w, w.techA1.employeeId as string, { kind: "SKILL", skillId: ids.hvac, level: 4 });
  await qualify(w, w.techA1.employeeId as string, { kind: "LICENSE", certificationId: ids.epa });
  await qualify(w, w.techA1Other.employeeId as string, { kind: "SKILL", skillId: ids.hvac, level: 4 });
  await authorize(w, w.techA1.employeeId as string, ["repair", "inspection"]);
  await authorize(w, w.techA1Other.employeeId as string, ["repair", "inspection"]);

  const makeCustomerWithAddress = async (orgUnitId: string, archived = false) => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId, archived });
    return { id: customer.id, addressId: await makeAddress(w.tenantId, customer.id, { orgUnitId, isPrimary: true }) };
  };
  return {
    ...w,
    cookie,
    ids,
    customerA: await makeCustomerWithAddress(w.units.cityA),
    customerB: await makeCustomerWithAddress(w.units.cityB),
    archivedCustomer: await makeCustomerWithAddress(w.units.cityA, true),
  };
}

/** Creates a job through the API (as `cookieValue`, default dispatcher) and returns the response body's data. */
export async function createJobViaApi(world: JobsWorld, body: Record<string, unknown> = {}, cookieValue?: string) {
  const response = await call(createJobRoute, "POST", "/api/v1/jobs", {
    cookie: cookieValue ?? world.cookie.dispatcher,
    body: { customerId: world.customerA.id, serviceAddressId: world.customerA.addressId, jobTypeId: world.ids.repairType, ...body },
  });
  if (response.status !== 201) throw new Error(`job creation failed: ${response.status} ${JSON.stringify(response.json)}`);
  return response.json.data as Record<string, any>;
}
