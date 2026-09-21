/**
 * Runnable entry for the owner bootstrap. The work and the reasoning are in
 * owner.ts; this file only decides whether to do it and what to print.
 *
 * Runs on every deploy, between `prisma migrate deploy` and the demo seed.
 * With neither variable set it is a silent no-op, which is the normal state
 * of a deployment.
 */
import { PrismaClient } from "@prisma/client";
import { bootstrapOwner, ownerConfig } from "./owner";

async function main() {
  const config = ownerConfig();
  if (!config) return;

  const prisma = new PrismaClient();
  try {
    const result = await bootstrapOwner(prisma, config);
    // The email, never the password - this output goes to the host's build
    // log, which is not a place a credential belongs.
    console.log(
      `[velto] owner bootstrap: ${result.created ? "created" : "updated"} ${result.email} as ADMIN`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // Loud. A misconfigured ADMIN account must fail the deploy rather than
  // leave the site running in a state the operator believes is fixed.
  console.error("[velto] owner bootstrap failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
