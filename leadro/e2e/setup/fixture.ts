/**
 * What the seed hands to the specs. It travels from globalSetup to the test workers as JSON in
 * one environment variable, so the generated password exists only in memory for the run and is
 * never written to disk.
 */
export interface E2eUser {
  email: string;
  /** Company code to type on the login form. */
  tenantSlug: string;
}

export interface E2eFixture {
  /** One generated password shared by every seeded user of the run. */
  password: string;
  /** Number of employees in the seeded tenant (the CEO sees all of them). */
  employeeCount: number;
  ceo: E2eUser & {
    /** Base32 TOTP seed the CEO's authenticator would hold; the test derives codes from it. */
    totpSecretBase32: string;
  };
  cityManager: E2eUser & {
    employeeNumber: string;
    /** An employee placed outside the City Manager's city (the COO, placed at the business unit). */
    outOfScopeEmployeeNumber: string;
  };
  technician: E2eUser;
  /** Dedicated to the lockout spec so locking it does not disturb the other specs. */
  lockoutTarget: E2eUser;
  /** An employee of the SAME tenant (the CEO), used as the positive control for the isolation spec. */
  ownEmployee: { id: string; fullName: string };
  /** An employee of a DIFFERENT tenant, for the isolation spec. */
  foreignEmployeeId: string;
}

export const FIXTURE_ENV_VAR = "E2E_FIXTURE";

/** Reads the fixture inside a test worker. */
export function readFixture(): E2eFixture {
  const raw = process.env[FIXTURE_ENV_VAR];
  if (!raw) throw new Error("E2E fixture missing: the globalSetup did not run.");
  return JSON.parse(raw) as E2eFixture;
}
