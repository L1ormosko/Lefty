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

// The suite creates tenants and users, so it only runs against a local database unless told otherwise.
const host = new URL(E2E_DATABASE_URL).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) && process.env.E2E_ALLOW_REMOTE_DB !== "1") {
  throw new Error("Refusing to run the E2E suite against a non-local database (set E2E_ALLOW_REMOTE_DB=1 to allow it).");
}
