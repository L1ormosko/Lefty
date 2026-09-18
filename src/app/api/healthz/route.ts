import { prisma } from "@/server/db";

/**
 * Liveness and readiness in one endpoint.
 *
 * "The Node process is up" is not what anyone monitoring this wants to know -
 * this application is unusable without its database, and a host that restarts
 * on a failing health check should restart on that. So the check is a real
 * query, and the cheapest one there is.
 *
 * Deliberately says nothing else: no version, no connection string, no row
 * counts, no environment. A health endpoint is unauthenticated by definition,
 * which makes every field on it public.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[velto] healthz: database unreachable:", err);
    return Response.json(
      { status: "error" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
