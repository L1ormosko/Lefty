/**
 * The owner bootstrap: how a locked-out operator gets back into their own
 * platform.
 *
 * It lives apart from bootstrap.ts for the same reason seed-config.ts lives
 * apart from seed.ts - that file runs on import, so a test importing it would
 * do the work rather than assert on it.
 *
 * Why this exists at all. The production database accepts no external
 * connections (its IP allow list is empty), password recovery by email is not
 * configured, and role changes are made from an admin screen you have to be
 * an admin to reach. Those three are individually defensible and together
 * they are a locked door with the key inside: the only administrator is
 * whoever the seed happened to create, and nobody can reach the account.
 *
 * So: two environment variables, set on the host where the secrets already
 * live, applied on deploy. It is a back door and it is described as one - the
 * mitigations are that it opens only when deliberately configured, refuses a
 * weak password, and writes an audit row every time it acts.
 */
import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/** Only what these functions read, so a test can pass a plain object. */
type OwnerEnv = {
  VELTO_OWNER_EMAIL?: string;
  VELTO_OWNER_PASSWORD?: string;
  [key: string]: string | undefined;
};

/**
 * Shorter than SEED_PASSWORD's 24 because a human types this one, and a
 * requirement nobody can meet gets met with "Password123" instead.
 */
export const MIN_OWNER_PASSWORD_LENGTH = 12;

export type OwnerConfig = { email: string; password: string };

/**
 * What to bootstrap, or null for "nothing asked of us".
 *
 * Three outcomes, and the difference between the second and third is the
 * point: neither variable set is the normal state of a deployment and must
 * stay silent, while a half-set or weak configuration is somebody trying to
 * create an ADMIN account and getting it wrong - that fails the deploy rather
 * than quietly producing an administrator with a guessable password.
 */
export function ownerConfig(env: OwnerEnv = process.env): OwnerConfig | null {
  const email = env.VELTO_OWNER_EMAIL?.trim().toLowerCase() ?? "";
  const password = env.VELTO_OWNER_PASSWORD ?? "";

  if (!email && !password) return null;

  if (!email || !password) {
    throw new Error(
      "VELTO_OWNER_EMAIL and VELTO_OWNER_PASSWORD must be set together. " +
        `Got ${email ? "an email with no password" : "a password with no email"}.`
    );
  }
  // Not a validation library: this is a typo guard on a value an operator
  // typed into a hosting dashboard, not user input being accepted.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`VELTO_OWNER_EMAIL is not an email address: ${email}`);
  }
  if (password.length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new Error(
      `VELTO_OWNER_PASSWORD must be at least ${MIN_OWNER_PASSWORD_LENGTH} characters ` +
        `(got ${password.length}). This account is an ADMIN on a public site.`
    );
  }

  return { email, password };
}

/** Matches server/auth.ts. Stated here because that module is server-only and
 *  this one runs under tsx during the build, where it cannot be imported. */
const BCRYPT_ROUNDS = 12;

/** A year is arbitrary; it is long enough that the operator is not locked out
 *  again by a date, and short enough to be visibly a granted term. */
const ACCESS_YEARS = 1;

export type BootstrapResult = { email: string; created: boolean; promoted: boolean };

/**
 * Create or re-assert the owner account.
 *
 * Idempotent by design, and re-applied on every deploy while the variables are
 * set: that is the recovery property, not an accident. Re-running it after a
 * forgotten password is exactly how the operator gets back in.
 *
 * Three things it deliberately does beyond creating a login:
 *
 * - `isDemo: false`. seed.ts deletes `{ isDemo: true }` on every deploy and
 *   this account has to survive that, which is the whole point of it.
 * - `role: "ADMIN"` every time, not only on create, so an account that already
 *   exists as an advertiser - the usual case, because the operator registered
 *   through the site like anyone else - is promoted rather than left out.
 * - a paid subscription. Access is decided by `paidThrough` alone; an admin
 *   with no subscription can reach /admin but still meets the paywall on the
 *   listing pages, which is precisely the half-working state this is fixing.
 */
export async function bootstrapOwner(
  prisma: PrismaClient,
  config: OwnerConfig
): Promise<BootstrapResult> {
  const passwordHash = await bcrypt.hash(config.password, BCRYPT_ROUNDS);
  const existing = await prisma.user.findUnique({
    where: { email: config.email },
    select: { id: true, role: true },
  });

  const paidThrough = new Date();
  paidThrough.setUTCFullYear(paidThrough.getUTCFullYear() + ACCESS_YEARS);

  const user = await prisma.user.upsert({
    where: { email: config.email },
    create: {
      email: config.email,
      passwordHash,
      name: config.email.split("@")[0],
      role: "ADMIN",
      isActive: true,
      isDemo: false,
      // Creating the account here means nobody clicked the checkbox. The
      // person setting these variables owns the platform and its terms; the
      // field records when they accepted, and that is now.
      termsAcceptedAt: new Date(),
    },
    update: {
      passwordHash,
      role: "ADMIN",
      isActive: true,
      isDemo: false,
      // name, phone, company and every other profile field are left alone:
      // this is a key, not a profile editor.
    },
  });

  await prisma.subscription.upsert({
    where: { userId: user.id },
    create: { userId: user.id, paidThrough, note: "VELTO_OWNER bootstrap" },
    update: { paidThrough },
  });

  /*
   * Written directly rather than through server/audit.ts, which is
   * server-only. `actorId: null` because no signed-in user did this - the
   * host configuration did, and the summary says so. A door like this being
   * silent is how it stops being noticed.
   */
  await prisma.auditLog
    .create({
      data: {
        actorId: null,
        action: "USER_ROLE_CHANGED",
        targetType: "User",
        targetId: user.id,
        summary: `${existing ? "promoted" : "created"} ${user.email} · ADMIN · VELTO_OWNER bootstrap`,
      },
    })
    // Same rule as recordAudit: logging must never break the thing logged.
    .catch((err: unknown) => console.error("[velto] bootstrap audit failed:", err));

  return {
    email: user.email,
    created: !existing,
    promoted: !!existing && existing.role !== "ADMIN",
  };
}
