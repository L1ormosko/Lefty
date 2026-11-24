import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomer, createCustomerSchema } from "@/server/customers";
import { createLead, createLeadSchema } from "@/server/leads";
import { disconnect, buildWorld, type World } from "../authz/fixtures";
import { contextFor } from "../org/org-helpers";

let w: World;
beforeAll(async () => {
  w = await buildWorld("creation-burst");
});
afterAll(disconnect);

// Well above the default Prisma pool (num_cpus * 2 + 1). A create that needed a SECOND pooled connection for its
// number (a nested withTenant) would starve the pool and fail with P2024 once the burst exceeds it.
const BURST = 40;

describe("creation bursts", () => {
  it("creates more customers concurrently than the pool has connections, with distinct numbers", async () => {
    const actor = w.ceo.actor;
    const results = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        createCustomer(actor, contextFor(actor), createCustomerSchema.parse({ name: `Burst ${i}`, orgUnitId: w.units.cityA, addresses: [] })),
      ),
    );
    expect(new Set(results.map((r) => r.number)).size).toBe(BURST);
  }, 60_000);

  it("creates more leads concurrently than the pool has connections, with distinct numbers", async () => {
    const actor = w.ceo.actor;
    const results = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        createLead(actor, contextFor(actor), createLeadSchema.parse({ contactName: `Burst ${i}`, orgUnitId: w.units.cityA })),
      ),
    );
    expect(new Set(results.map((r) => (r.data as { number: number }).number)).size).toBe(BURST);
  }, 60_000);
});
