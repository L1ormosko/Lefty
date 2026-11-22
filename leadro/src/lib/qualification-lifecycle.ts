/**
 * Status machine of an employee's skill or credential (§10.1, §25.5). Pure: the one place that says
 * which status changes are allowed; the service calls `assertQualificationTransition`.
 *
 *   PENDING_VERIFICATION --verify--> VERIFIED --revoke--> REVOKED
 *            |                          |                    |
 *          reject                  edit (material)         resubmit (edit)
 *            v                          v                    v
 *         REJECTED  --resubmit(edit)--> PENDING_VERIFICATION <-+
 *
 * Only HR-type roles (`qualifications.approve`) verify, reject or revoke. Anyone who may edit the
 * record can change its facts, but a material change (level, number, dates, authority) or any edit of
 * a rejected / revoked row sends it back to PENDING_VERIFICATION, so editing can never launder an
 * unverified credential into a verified one.
 */
export type QualificationStatusValue = "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "REVOKED";

export const QUALIFICATION_TRANSITIONS: Readonly<Record<QualificationStatusValue, readonly QualificationStatusValue[]>> = {
  PENDING_VERIFICATION: ["VERIFIED", "REJECTED"],
  VERIFIED: ["REVOKED", "PENDING_VERIFICATION"],
  REJECTED: ["PENDING_VERIFICATION"],
  REVOKED: ["PENDING_VERIFICATION"],
};

export function canTransitionQualification(from: QualificationStatusValue, to: QualificationStatusValue): boolean {
  return QUALIFICATION_TRANSITIONS[from].includes(to);
}

/** Fields whose change invalidates an earlier verification. Notes are not verified facts. */
export const VERIFIED_FACT_FIELDS = ["level", "number", "issuingAuthority", "issuedAt", "expiresAt"] as const;
