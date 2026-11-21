import { prisma } from "@/server/db";

let counter = 0;

/** Creates an isolated tenant (the Tenant table is not RLS-protected). */
export async function createTenant(label = "t") {
  counter += 1;
  const slug = `${label}-${Date.now().toString(36)}-${counter}`;
  return prisma.tenant.create({ data: { slug, name: `Tenant ${slug}` } });
}

export async function rawCount(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${table}"`);
  return Number(rows[0].n);
}
