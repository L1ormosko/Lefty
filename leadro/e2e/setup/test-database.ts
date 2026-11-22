/**
 * Which database the browser suite runs against. The suite creates tenants and signs users in
 * (which writes sessions and audit events), so it must NEVER touch the development database:
 * the name has to end in `_test`, the same rule the Vitest global setup applies.
 */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "postgresql://leadro:leadro@127.0.0.1:5432/leadro_test";

if (!/\/[^/?]*_test(\?|$)/.test(E2E_DATABASE_URL)) {
  throw new Error("Refusing to run the E2E suite: the database name must end in _test.");
}
