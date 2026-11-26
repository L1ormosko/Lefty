import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as catalogRoute } from "@/app/api/v1/performance/catalog/route";
import { GET as listDefinitionsRoute, POST as createDefinitionRoute } from "@/app/api/v1/performance/definitions/route";
import { GET as getDefinitionRoute, PATCH as updateDefinitionRoute } from "@/app/api/v1/performance/definitions/[id]/route";
import { POST as submitRoute } from "@/app/api/v1/performance/definitions/[id]/submit/route";
import { POST as computeRoute } from "@/app/api/v1/performance/definitions/[id]/compute/route";
import { GET as listValuesRoute } from "@/app/api/v1/performance/values/route";
import { GET as getValueRoute } from "@/app/api/v1/performance/values/[id]/route";
import { GET as employeeValuesRoute } from "@/app/api/v1/performance/employees/[employeeId]/values/route";
import { POST as decideRoute } from "@/app/api/v1/approvals/[id]/decide/route";
import { disconnect } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { buildPerformanceWorld, type PerformanceWorld } from "./fixtures";

let w: PerformanceWorld;
const cookie: Record<string, string> = {};

beforeAll(async () => {
  w = await buildPerformanceWorld("perf-routes");
  for (const name of ["hr", "ceo", "cityManagerA", "techA1", "dispatcher"] as const) cookie[name] = await sessionCookie(w[name], w.tenantId);
});
afterAll(disconnect);

describe("the performance API", () => {
  it("author -> submit -> publish -> compute -> read over HTTP", async () => {
    const catalog = await call(catalogRoute, "GET", "/x", { cookie: cookie.techA1 });
    expect(catalog.status).toBe(200);
    expect(catalog.json.data).toHaveLength(7);

    const forbidden = await call(createDefinitionRoute, "POST", "/x", { cookie: cookie.cityManagerA, body: { key: "training", kind: "TRAINING_PROGRESS", name: "Training", minSample: 1 } });
    expect(forbidden.status).toBe(403);
    const bad = await call(createDefinitionRoute, "POST", "/x", { cookie: cookie.hr, body: { key: "weighted", kind: "OUTCOME_CONVERSION", name: "W", params: { weight: 2 }, minSample: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.field).toBe("params.weight");

    const created = await call(createDefinitionRoute, "POST", "/x", { cookie: cookie.hr, body: { key: "training", kind: "TRAINING_PROGRESS", name: "Training", minSample: 1 } });
    expect(created.status).toBe(201);
    const id = created.json.data.id as string;
    expect((await call(updateDefinitionRoute, "PATCH", "/x", { cookie: cookie.hr, params: { id }, body: { name: "Training progress" } })).json.data.name).toBe("Training progress");
    expect((await call(getDefinitionRoute, "GET", "/x", { cookie: cookie.techA1, params: { id } })).status).toBe(404);

    const submitted = await call(submitRoute, "POST", "/x", { cookie: cookie.hr, params: { id }, body: {} });
    expect(submitted.json.data.status).toBe("PENDING_APPROVAL");
    const decided = await call(decideRoute, "POST", "/x", { cookie: cookie.ceo, params: { id: submitted.json.data.approvalRequestId }, body: { decision: "APPROVE" } });
    expect(decided.status).toBe(200);
    const listed = await call(listDefinitionsRoute, "GET", "/x", { cookie: cookie.techA1, query: { key: "training" } });
    expect(listed.json.data.map((row: { status: string }) => row.status)).toEqual(["PUBLISHED"]);

    const period = { periodStart: "2026-01-01", periodEnd: "2026-02-01" };
    expect((await call(computeRoute, "POST", "/x", { cookie: cookie.techA1, params: { id }, body: period })).status).toBe(403);
    const computed = await call(computeRoute, "POST", "/x", { cookie: cookie.cityManagerA, params: { id }, body: { ...period, employeeIds: [w.techA1.employeeId] } });
    expect(computed.status).toBe(201);
    const valueId = computed.json.data.values[0].id as string;

    const own = await call(employeeValuesRoute, "GET", "/x", { cookie: cookie.techA1, params: { employeeId: w.techA1.employeeId as string } });
    expect(own.status).toBe(200);
    expect(own.json.data[0]).toMatchObject({ id: valueId, key: "training", dimension: "TRAINING_PROGRESS", sampleSize: 0, enoughData: false, evidenceCount: 0 });
    const other = await call(employeeValuesRoute, "GET", "/x", { cookie: cookie.techA1, params: { employeeId: w.techA1Other.employeeId as string } });
    expect(other.status).toBe(404);
    expect((await call(getValueRoute, "GET", "/x", { cookie: cookie.techA1, params: { id: valueId } })).json.data.evidenceIds).toEqual([]);
    expect((await call(listValuesRoute, "GET", "/x", { cookie: cookie.dispatcher })).status).toBe(403);
  });
});
