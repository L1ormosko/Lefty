import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createJob, createJobSchema, listJobs, listJobsQuerySchema } from "@/server/jobs";

/** GET /api/v1/jobs: newest first, scope-filtered, each row projected to what its grants reveal. */
export const GET = defineRoute({
  schemas: { query: listJobsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view"),
  handler: async ({ ctx, input }) => respond(200, await listJobs(actorOf(ctx), input.query)),
});

/** POST /api/v1/jobs: manual creation; the service checks `jobs.create` over the service-area unit. */
export const POST = defineRoute({
  schemas: { body: createJobSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createJob(actorOf(ctx), ctx, input.body)),
});
