import { nextNumber } from "@/server/core";
import { withTenant } from "@/server/db";
import { normalizeAddressKey } from "@/lib/address-key";

/** Direct-to-database builders for customers, leads, jobs and their assignments (bypassing the services under test). */

let counter = 0;
const unique = (label: string) => `${label}-${Date.now().toString(36)}-${(counter += 1)}`;

export async function makeCustomer(
  tenantId: string,
  data: {
    name?: string;
    orgUnitId?: string | null;
    phoneE164?: string | null;
    email?: string | null;
    taxId?: string | null;
    archived?: boolean;
  } = {},
): Promise<{ id: string; number: number; name: string }> {
  return withTenant(tenantId, async (tx) => {
    const name = data.name ?? unique("Customer");
    const customer = await tx.customer.create({
      data: {
        tenantId,
        number: await nextNumber(tx, tenantId, "customer"),
        name,
        orgUnitId: data.orgUnitId ?? null,
        phone: data.phoneE164 ?? null,
        phoneE164: data.phoneE164 ?? null,
        email: data.email ?? null,
        taxId: data.taxId ?? null,
        archivedAt: data.archived ? new Date() : null,
      },
    });
    return { id: customer.id, number: customer.number, name };
  });
}

export async function makeAddress(
  tenantId: string,
  customerId: string,
  data: { line1?: string; city?: string; postalCode?: string; orgUnitId?: string; isPrimary?: boolean } = {},
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const address = {
      line1: data.line1 ?? "12 Main St",
      line2: null,
      city: data.city ?? "Springfield",
      region: "IL",
      postalCode: data.postalCode ?? "62701",
      countryCode: "US",
    };
    const row = await tx.customerAddress.create({
      data: {
        tenantId,
        customerId,
        ...address,
        orgUnitId: data.orgUnitId ?? null,
        isPrimary: data.isPrimary ?? false,
        normalizedKey: normalizeAddressKey(address),
      },
    });
    return row.id;
  });
}

/** One job type per tenant, created on first use. */
async function jobTypeId(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.jobType.findFirst({ where: { tenantId, code: "fixture-type" } });
    if (existing) return existing.id;
    const created = await tx.jobType.create({
      data: { tenantId, code: "fixture-type", name: "Fixture type", category: "repair", defaultDurationMinutes: 60 },
    });
    return created.id;
  });
}

export async function makeJob(
  tenantId: string,
  customerId: string,
  orgUnitId: string,
  data: { archived?: boolean } = {},
): Promise<string> {
  const addressId = await makeAddress(tenantId, customerId, { line1: unique("Job St"), orgUnitId });
  const typeId = await jobTypeId(tenantId);
  return withTenant(tenantId, async (tx) => {
    const job = await tx.job.create({
      data: {
        tenantId,
        number: await nextNumber(tx, tenantId, "job"),
        customerId,
        serviceAddressId: addressId,
        jobTypeId: typeId,
        orgUnitId,
        title: "Fixture job",
        estimatedDurationMinutes: 60,
        archivedAt: data.archived ? new Date() : null,
      },
    });
    return job.id;
  });
}

export async function makeLead(tenantId: string, customerId: string, data: { orgUnitId?: string; archived?: boolean } = {}): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const lead = await tx.lead.create({
      data: {
        tenantId,
        number: await nextNumber(tx, tenantId, "lead"),
        customerId,
        orgUnitId: data.orgUnitId ?? null,
        archivedAt: data.archived ? new Date() : null,
      },
    });
    return lead.id;
  });
}

/** Assigns a job to an employee or to a whole team (org unit). Returns the assignment id. */
export async function assignJob(
  tenantId: string,
  jobId: string,
  target: { employeeId: string } | { teamOrgUnitId: string },
  state: "ACTIVE" | "ENDED" = "ACTIVE",
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.jobAssignment.create({
      data: {
        tenantId,
        jobId,
        employeeId: "employeeId" in target ? target.employeeId : null,
        teamOrgUnitId: "teamOrgUnitId" in target ? target.teamOrgUnitId : null,
        state,
        endedAt: state === "ENDED" ? new Date() : null,
      },
    });
    return row.id;
  });
}

export async function assignLead(
  tenantId: string,
  leadId: string,
  employeeId: string,
  state: "ACTIVE" | "ENDED" = "ACTIVE",
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.leadAssignment.create({
      data: { tenantId, leadId, employeeId, state, endedAt: state === "ENDED" ? new Date() : null },
    });
    return row.id;
  });
}
