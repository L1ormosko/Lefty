import { execSync } from "node:child_process";

/**
 * Runs once per `vitest run`: applies all pending migrations to the test database with
 * `prisma migrate deploy` (forward-only, non-destructive) so tests exercise the real schema, RLS
 * policies and triggers. Tests create their own uniquely named tenants and never assume an empty
 * database. Refuses to run against any database whose name does not end in `_test`.
 *
 * Wiping the test database (needed only if an already-applied migration is edited) is a manual,
 * human-run step: see README "Resetting the test database".
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (!/\/[^/?]*_test(\?|$)/.test(url)) {
    throw new Error(`Refusing to migrate a non-test database: ${url.replace(/:[^:@]*@/, ":***@")}`);
  }
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
}
