/**
 * Configuration for the demo seed, in its own module so it can be tested.
 *
 * It lives apart from seed.ts because that file runs main() on import - a test
 * importing it would seed the database rather than assert on the guard.
 */

/** Long enough that nobody is tempted to type one in by hand. */
export const MIN_PASSWORD_LENGTH = 24;

/**
 * The password for the seeded accounts. There is deliberately no default.
 *
 * The repository is public and the deploy's build command ends with
 * `npm run seed:dev`, so a password written into the source was a working
 * ADMIN login for the live site, published on GitHub. A fallback value is
 * exactly how that comes back quietly, so a missing or weak value throws and
 * the deploy fails loudly instead. See DECISIONS.md 16.
 */
export function requireSeedPassword(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SEED_PASSWORD;
  if (!value) {
    throw new Error(
      "SEED_PASSWORD is not set. This seed creates an ADMIN account, so it refuses " +
        "to run with a built-in password.\n" +
        "Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\"\n" +
        "then put it in .env locally, or set it as an environment variable on the host."
    );
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters (got ${value.length}).`
    );
  }
  return value;
}

/**
 * Whether to create demo data at all.
 *
 * The switch that turns the demo off for a real launch: one environment
 * variable rather than a code change, which matters because the seed deletes
 * and recreates the demo rows on every single deploy.
 */
export function demoSeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEED_DEMO === "1";
}
