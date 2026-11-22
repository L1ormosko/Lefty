import { prisma } from "@/server/db";
import { FIXTURE_ENV_VAR } from "./fixture";
import { seedE2e } from "./seed-e2e";

/**
 * Runs once before the specs: seeds fresh tenants and exposes them to the workers through the
 * environment (workers are spawned after this returns, so they inherit it).
 */
export default async function globalSetup(): Promise<void> {
  const fixture = await seedE2e();
  process.env[FIXTURE_ENV_VAR] = JSON.stringify(fixture);
  await prisma.$disconnect();
}
