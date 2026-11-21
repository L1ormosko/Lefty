import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explainParentViolation } from "@/lib/org-hierarchy";
import { hashPassword, verifyPassword } from "@/server/auth";
import { can, ROLE_TEMPLATES } from "@/server/authz";
import { listEmployees } from "@/server/employees";
import { prisma, withTenant } from "@/server/db";
import { seedTenant, type SeedTenantResult } from "../../prisma/seed/seed-tenant";
import { TENANT_SPECS, type TenantSpec } from "../../prisma/seed/tenant-specs";
import { disconnect, toActor } from "../authz/fixtures";

const SEED_PASSWORD = "dev-seed-password-123";
const suffix = Math.random().toString(36).slice(2, 8);
// Unique company codes so the real dev seed (acme-field / globex-home) is never touched by tests.
const specs: TenantSpec[] = TENANT_SPECS.map((spec, index) => ({ ...spec, slug: `seedtest-${index}-${suffix}` }));
let results: SeedTenantResult[];
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(SEED_PASSWORD);
  results = [];
  for (const spec of specs) results.push(await seedTenant(spec, passwordHash));
}, 120_000);
afterAll(disconnect);

describe("development seed", () => {
  it("creates two separate tenants with one ACTIVE user per role template, none sharing data", async () => {
    expect(results.map((result) => result.created)).toEqual([true, true]);
    expect(results[0].tenantId).not.toBe(results[1].tenantId);
    for (const result of results) {
      expect(result.people.map((person) => person.roleTemplate).sort()).toEqual(ROLE_TEMPLATES.map((template) => template.key).sort());
      const users = await withTenant(result.tenantId, (tx) => tx.user.findMany());
      expect(users).toHaveLength(ROLE_TEMPLATES.length);
      expect(users.every((user) => user.status === "ACTIVE" && user.email.endsWith(`@${result.slug}.example.test`))).toBe(true);
    }
    // each tenant only sees its own rows through row-level security
    const [first, second] = results;
    const crossCount = await withTenant(first.tenantId, (tx) => tx.user.count({ where: { tenantId: second.tenantId } }));
    expect(crossCount).toBe(0);
  });

  it("stores only a bcrypt hash of SEED_PASSWORD (never the password) and the users can use it", async () => {
    const users = await withTenant(results[0].tenantId, (tx) => tx.user.findMany({ select: { passwordHash: true } }));
    for (const user of users) {
      expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
      expect(user.passwordHash).not.toContain(SEED_PASSWORD);
    }
    expect(await verifyPassword(SEED_PASSWORD, users[0].passwordHash!)).toBe(true);
    const audit = await withTenant(results[0].tenantId, (tx) => tx.auditEvent.findMany());
    expect(JSON.stringify(audit)).not.toContain(SEED_PASSWORD);
  });

  it("builds a US hierarchy: legal entities A/B, Texas/Florida/California, regions, cities, branches, teams", async () => {
    await withTenant(results[0].tenantId, async (tx) => {
      const entities = await tx.legalEntity.findMany();
      expect(entities).toHaveLength(2);
      const units = await tx.orgUnit.findMany();
      const byType = (type: string) => units.filter((unit) => unit.type === type);
      expect(byType("STATE").map((unit) => unit.name).sort()).toEqual(["California", "Florida", "Texas"]);
      for (const type of ["REGION", "CITY", "BRANCH", "TEAM"]) expect(byType(type).length).toBeGreaterThan(0);
      expect(byType("BRANCH").every((unit) => unit.timeZone && unit.address)).toBe(true);
      // the seed obeys the same hierarchy rules the API enforces
      const typeOf = new Map(units.map((unit) => [unit.id, unit.type]));
      for (const unit of units) {
        const parent = unit.parentId ? typeOf.get(unit.parentId) ?? null : null;
        expect(explainParentViolation(unit.type, parent)).toBeNull();
      }
      // both legal entities are in use
      expect(new Set(units.map((unit) => unit.legalEntityId)).size).toBe(2);
    });
  });

  it("grants every template with an explicit scope, through the authorization tables", async () => {
    await withTenant(results[0].tenantId, async (tx) => {
      const assignments = await tx.roleAssignment.findMany({ include: { scopes: true, role: true } });
      expect(assignments).toHaveLength(ROLE_TEMPLATES.length);
      expect(assignments.every((assignment) => assignment.scopes.length > 0)).toBe(true);
      expect(assignments.find((assignment) => assignment.role.templateKey === "TECHNICIAN")?.scopes.map((scope) => scope.type).sort()).toEqual(["ASSIGNED", "OWN"]);
    });
  });

  it("the seeded access model behaves: the state manager's list covers Texas only, the technician only themselves", async () => {
    const tenant = results[0];
    const actorFor = async (login: string) => {
      const user = await withTenant(tenant.tenantId, (tx) =>
        tx.user.findFirstOrThrow({ where: { email: `${login}@${tenant.slug}.example.test` }, include: { employee: true } }),
      );
      return toActor(tenant.tenantId, user.id, user.employee?.id ?? null);
    };
    const page = (login: string) => actorFor(login).then((actor) => listEmployees(actor, { limit: 50 }));

    const owner = await page("owner");
    expect(owner.data).toHaveLength(ROLE_TEMPLATES.length);
    const stateManager = await page("state-manager");
    expect(stateManager.data.length).toBeGreaterThan(0);
    expect(stateManager.data.length).toBeLessThan(ROLE_TEMPLATES.length); // the corporate staff at the top are out of its scope
    const technician = await page("technician");
    expect(technician.data).toHaveLength(1);

    const stateActor = await actorFor("state-manager");
    expect((await can(stateActor, "organization.create")).allowed).toBe(true);
  });

  it("is idempotent: seeding an existing company code changes nothing", async () => {
    const before = await withTenant(results[0].tenantId, (tx) => tx.user.count());
    const again = await seedTenant(specs[0], passwordHash);
    expect(again).toMatchObject({ created: false, tenantId: results[0].tenantId });
    expect(await withTenant(results[0].tenantId, (tx) => tx.user.count())).toBe(before);
    expect(await prisma.tenant.count({ where: { slug: specs[0].slug } })).toBe(1);
  });
});

describe("seed command safety", () => {
  const root = path.join(__dirname, "../..");
  const run = (env: Record<string, string | undefined>) =>
    spawnSync("npx", ["tsx", "prisma/seed.ts"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } as NodeJS.ProcessEnv, timeout: 60_000 });

  it("refuses without SEED_PASSWORD or with a short one, and never prints a password", () => {
    const missing = run({ SEED_PASSWORD: undefined });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/SEED_PASSWORD/);

    const short = run({ SEED_PASSWORD: "only-15-chars-x" });
    expect(short.status).not.toBe(0);
    expect(short.stderr).toMatch(/at least 16/);
    expect(short.stdout + short.stderr).not.toContain("only-15-chars-x");
  }, 90_000);

  it("refuses to run in production even with a valid password", () => {
    const secret = "a-perfectly-long-secret-value";
    const production = run({ SEED_PASSWORD: secret, NODE_ENV: "production" });
    expect(production.status).not.toBe(0);
    expect(production.stderr).toMatch(/production/);
    expect(production.stdout + production.stderr).not.toContain(secret);
  }, 90_000);
});
