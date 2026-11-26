import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { grantTrainingQualificationInTx, restateTrainingQualificationInTx } from "@/server/qualifications";
import { buildWorld, disconnect, toActor, type World } from "../authz/fixtures";
import { auditEvents, contextFor } from "../org/org-helpers";

let w: World;
const unique = (label: string) => `${label}${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  w = await buildWorld("tqual");
});
afterAll(disconnect);

const hrCtx = () => contextFor(toActor(w.tenantId, w.hr.userId, null));

async function newCertification(type: "TRAINING" | "LICENSE" = "TRAINING") {
  return withTenant(w.tenantId, (tx) => tx.certification.create({ data: { tenantId: w.tenantId, code: unique("c"), name: "Course cert", type } }));
}

const grant = (certificationId: string, completedOn: string, expiresOn: string | null, employeeId = w.techA1.employeeId as string) =>
  withTenant(w.tenantId, (tx) =>
    grantTrainingQualificationInTx(tx, hrCtx(), { employeeId, certificationId, completedOn, expiresOn, trainingRecordId: "rec-1" }),
  );
const load = (id: string) => withTenant(w.tenantId, (tx) => tx.employeeQualification.findUniqueOrThrow({ where: { id } }));
const iso = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

describe("grantTrainingQualificationInTx", () => {
  it("creates a VERIFIED TRAINING qualification with the completion's dates, verified by the actor, audited", async () => {
    const cert = await newCertification();
    const result = await grant(cert.id, "2026-11-01", "2027-11-01");
    expect(result.outcome).toBe("CREATED");
    const row = await load(result.qualificationId);
    expect(row).toMatchObject({ kind: "TRAINING", status: "VERIFIED", verifiedById: w.hr.userId, certificationId: cert.id });
    expect([iso(row.issuedAt), iso(row.expiresAt)]).toEqual(["2026-11-01", "2027-11-01"]);
    expect(await auditEvents(w.tenantId, "qualification.training_grant", row.id)).toHaveLength(1);
  });

  it("renews the same record when the expiry reaches further, and never shortens it", async () => {
    const cert = await newCertification();
    const first = await grant(cert.id, "2026-11-01", "2027-11-01");
    const renewed = await grant(cert.id, "2027-10-20", "2028-10-20");
    expect(renewed).toEqual({ qualificationId: first.qualificationId, outcome: "RENEWED" });
    expect(iso((await load(first.qualificationId)).expiresAt)).toBe("2028-10-20");

    const older = await grant(cert.id, "2026-05-01", "2027-05-01");
    expect(older.outcome).toBe("UNCHANGED");
    expect(iso((await load(first.qualificationId)).expiresAt)).toBe("2028-10-20");

    const forever = await grant(cert.id, "2026-12-01", null);
    expect(forever.outcome).toBe("RENEWED");
    expect((await load(first.qualificationId)).expiresAt).toBeNull();
  });

  it("verifies a pending hand-recorded record instead of creating a second one; leaves revoked history alone", async () => {
    const cert = await newCertification();
    const pending = await withTenant(w.tenantId, (tx) =>
      tx.employeeQualification.create({ data: { tenantId: w.tenantId, employeeId: w.techA1Other.employeeId as string, kind: "TRAINING", certificationId: cert.id } }),
    );
    const result = await grant(cert.id, "2026-11-01", null, w.techA1Other.employeeId as string);
    expect(result).toEqual({ qualificationId: pending.id, outcome: "RENEWED" });
    expect((await load(pending.id)).status).toBe("VERIFIED");

    const revokedCert = await newCertification();
    const revoked = await withTenant(w.tenantId, (tx) =>
      tx.employeeQualification.create({ data: { tenantId: w.tenantId, employeeId: w.techB.employeeId as string, kind: "TRAINING", certificationId: revokedCert.id, status: "REVOKED" } }),
    );
    const fresh = await grant(revokedCert.id, "2026-11-01", null, w.techB.employeeId as string);
    expect(fresh.outcome).toBe("CREATED");
    expect(fresh.qualificationId).not.toBe(revoked.id);
    expect((await load(revoked.id)).status).toBe("REVOKED");
  });

  it("refuses a certification that is not of type TRAINING, and an expiry not after the completion", async () => {
    const license = await newCertification("LICENSE");
    await expect(grant(license.id, "2026-11-01", null)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const cert = await newCertification();
    await expect(grant(cert.id, "2026-11-01", "2026-11-01")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("restateTrainingQualificationInTx", () => {
  it("revokes without a basis, resets dates with one, and leaves a non-verified record alone", async () => {
    const cert = await newCertification();
    const { qualificationId } = await grant(cert.id, "2026-11-01", "2028-11-01");
    const restate = (basis: { completedOn: string; expiresOn: string | null } | null) =>
      withTenant(w.tenantId, (tx) => restateTrainingQualificationInTx(tx, hrCtx(), { qualificationId, basis, reason: "record revoked" }));

    expect(await restate({ completedOn: "2026-01-01", expiresOn: "2027-01-01" })).toBe("RESTATED");
    expect(iso((await load(qualificationId)).expiresAt)).toBe("2027-01-01");
    expect(await restate({ completedOn: "2026-01-01", expiresOn: "2027-01-01" })).toBe("UNCHANGED");
    expect(await restate(null)).toBe("REVOKED");
    expect((await load(qualificationId)).status).toBe("REVOKED");
    expect(await auditEvents(w.tenantId, "qualification.revoke", qualificationId)).toHaveLength(1);
    expect(await restate(null)).toBe("UNCHANGED");
  });
});
