import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { auditEvents } from "../org/org-helpers";
import { createJobViaApi } from "../jobs/fixtures";
import { approve, buildDispatchWorld, candidates, generate, getSettings, listFor, putSettings, read, reject, type DispatchWorld } from "./fixtures";

let w: DispatchWorld;
let other: DispatchWorld;
beforeAll(async () => {
  w = await buildDispatchWorld("dispatch-access");
  other = await buildDispatchWorld("dispatch-access-other");
});
afterAll(disconnect);

describe("dispatch modes", () => {
  it("defaults to AI_ASSISTED and lists which modes can be chosen", async () => {
    const response = await getSettings(w.cookie.dispatcher);
    expect(response.status).toBe(200);
    expect(response.json.data.mode).toBe("AI_ASSISTED");
    expect(response.json.data.modes).toEqual([
      { mode: "MANUAL", available: true },
      { mode: "AI_ASSISTED", available: true },
      { mode: "RULE_BASED_AUTO", available: false },
      { mode: "OPTIMIZATION", available: false },
    ]);
  });

  it("refuses RULE_BASED_AUTO and OPTIMIZATION as not available in this phase, and an unknown mode", async () => {
    for (const mode of ["RULE_BASED_AUTO", "OPTIMIZATION"]) {
      const response = await putSettings(w.cookie.ceo, { mode });
      expect(response.status).toBe(400);
      expect(response.json.error.details[0]).toMatchObject({ field: "mode", code: "NOT_AVAILABLE" });
    }
    expect((await putSettings(w.cookie.ceo, { mode: "ROBOT" })).status).toBe(400);
    expect((await getSettings(w.cookie.ceo)).json.data.mode).toBe("AI_ASSISTED");
  });

  it("MANUAL switches recommendations off (409) but still shows who is eligible; AI_ASSISTED switches them back on; changes are audited", async () => {
    const job = await createJobViaApi(w, w.inspectionBody);
    expect((await putSettings(w.cookie.ceo, { mode: "MANUAL" })).json.data.mode).toBe("MANUAL");
    const refused = await generate(w.cookie.dispatcher, job.id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toMatch(/MANUAL/);
    const overview = await candidates(w.cookie.dispatcher, job.id);
    expect(overview.status).toBe(200);
    expect(overview.json.data.eligibleEmployeeIds).toEqual(expect.arrayContaining([w.techA1.employeeId, w.techA1Other.employeeId]));

    expect((await putSettings(w.cookie.ceo, { mode: "AI_ASSISTED" })).json.data.mode).toBe("AI_ASSISTED");
    expect((await generate(w.cookie.dispatcher, job.id)).status).toBe(201);
    const audits = await auditEvents(w.tenantId, "dispatch.mode_update");
    expect(audits.map((event) => (event.newValue as { mode: string }).mode)).toEqual(["AI_ASSISTED", "MANUAL"]);
  });

  it("refuses generation for a mode this phase cannot run even if it was stored some other way", async () => {
    const job = await createJobViaApi(other, other.inspectionBody);
    await withTenant(other.tenantId, (tx) =>
      tx.operationsSettings.upsert({ where: { tenantId: other.tenantId }, create: { tenantId: other.tenantId, dispatchMode: "RULE_BASED_AUTO" }, update: { dispatchMode: "RULE_BASED_AUTO" } }),
    );
    const response = await generate(other.cookie.dispatcher, job.id);
    expect(response.status).toBe(409);
    expect(response.json.error.message).toMatch(/not available in this phase/);
    await withTenant(other.tenantId, (tx) => tx.operationsSettings.update({ where: { tenantId: other.tenantId }, data: { dispatchMode: "AI_ASSISTED" } }));
  });
});

describe("access", () => {
  it("lets only holders of the dispatch permissions act: technicians and finance get 403", async () => {
    const job = await createJobViaApi(w, w.inspectionBody);
    expect((await generate(w.cookie.techA1, job.id)).status).toBe(403);
    expect((await generate(w.cookie.finance, job.id)).status).toBe(403);
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await approve(w.cookie.techA1, rec.id)).status).toBe(403);
    expect((await reject(w.cookie.techA1, rec.id, { reason: "no" })).status).toBe(403);
    expect((await putSettings(w.cookie.dispatcher, { mode: "MANUAL" })).status).toBe(403); // the mode is a tenant-wide setting
    expect((await putSettings(w.cookie.cityManagerA, { mode: "MANUAL" })).status).toBe(403); // no dispatch.manage
    expect((await getSettings(w.cookie.ceo)).json.data.mode).toBe("AI_ASSISTED");
  });

  it("hides a job outside the caller's scope: a City B manager gets 404 for a City A job and its recommendations", async () => {
    const job = await createJobViaApi(w, w.inspectionBody);
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await generate(w.cookie.cityManagerB, job.id)).status).toBe(404);
    expect((await candidates(w.cookie.cityManagerB, job.id)).status).toBe(404);
    expect((await listFor(w.cookie.cityManagerB, job.id)).status).toBe(404);
    expect((await read(w.cookie.cityManagerB, rec.id)).status).toBe(404);
    expect((await approve(w.cookie.cityManagerB, rec.id)).status).toBe(404);
    expect((await read(w.cookie.cityManagerA, rec.id)).status).toBe(200);
  });

  it("is tenant-isolated: another company cannot read, list or decide a recommendation", async () => {
    const job = await createJobViaApi(w, w.inspectionBody);
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await read(other.cookie.ceo, rec.id)).status).toBe(404);
    expect((await approve(other.cookie.ceo, rec.id)).status).toBe(404);
    expect((await listFor(other.cookie.ceo, job.id)).status).toBe(404);
    expect((await generate(other.cookie.ceo, job.id)).status).toBe(404);
  });

  it("refuses a job that can no longer be assigned", async () => {
    const job = await createJobViaApi(w, w.inspectionBody);
    await withTenant(w.tenantId, (tx) => tx.job.update({ where: { id: job.id }, data: { status: "CANCELLED" } }));
    expect((await generate(w.cookie.dispatcher, job.id)).status).toBe(409);
  });
});
