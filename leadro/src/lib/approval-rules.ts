/**
 * Pure rules of the approval engine (§21.3, §11.5): which policy applies to a change, what a set of decisions means, and
 * what may be stored in a request's `details`. No Prisma, no Next: unit-testable. The service (`src/server/approvals`) loads
 * the rows and applies these functions.
 */

export type ApprovalDecisionKindValue = "APPROVE" | "REJECT";

/** The policy columns the resolution needs. */
export interface PolicyBand {
  id: string;
  currency: string;
  minAmountMinor: bigint;
  maxAmountMinor: bigint | null;
  requiredApprovals: number;
}

/** An amount in minor units and its ISO currency. */
export interface ApprovalAmount {
  amountMinor: bigint;
  currency: string;
}

/** True when `amount` falls in the policy's band: same currency and `minAmountMinor <= amount < maxAmountMinor` (no max = open). */
export function policyCoversAmount(policy: PolicyBand, amount: ApprovalAmount): boolean {
  return (
    policy.currency === amount.currency &&
    amount.amountMinor >= policy.minAmountMinor &&
    (policy.maxAmountMinor === null || amount.amountMinor < policy.maxAmountMinor)
  );
}

/** Do two bands of the same currency share any amount? Used to refuse overlapping active policies. */
export function bandsOverlap(a: Omit<PolicyBand, "id" | "requiredApprovals">, b: Omit<PolicyBand, "id" | "requiredApprovals">): boolean {
  if (a.currency !== b.currency) return false;
  const aBelowB = a.maxAmountMinor !== null && a.maxAmountMinor <= b.minAmountMinor;
  const bBelowA = b.maxAmountMinor !== null && b.maxAmountMinor <= a.minAmountMinor;
  return !aBelowB && !bBelowA;
}

/**
 * The result of resolving a policy for a change:
 * - `policy`: the policy to snapshot into the request;
 * - `none`: approval is not required (no active policy of the subject type, or the amount falls in a gap between bands
 *   of its currency, which is how a tenant says "small amounts need no approval");
 * - `currency_not_covered`: the subject type has active policies, but none for this currency. The caller must REFUSE the
 *   change: silently skipping approval because nobody configured a currency would be fail-open.
 */
export type PolicyResolution<P extends PolicyBand> = { kind: "policy"; policy: P } | { kind: "none" } | { kind: "currency_not_covered" };

/**
 * Picks the policy for a change among the ACTIVE policies of its subject type.
 *
 * With an amount: the policy of that currency whose band covers it. Without one (a material cost change): any active policy
 * of the subject type. Should several match (overlap is refused when policies are written, so only a race or a manual
 * database edit causes it), the strictest wins: most required approvals, then the highest lower bound, then the id, so the
 * outcome is deterministic and never weaker than any matching policy.
 */
export function resolvePolicy<P extends PolicyBand>(activePolicies: readonly P[], amount: ApprovalAmount | null): PolicyResolution<P> {
  if (activePolicies.length === 0) return { kind: "none" };
  let candidates: P[];
  if (amount) {
    const ofCurrency = activePolicies.filter((policy) => policy.currency === amount.currency);
    if (ofCurrency.length === 0) return { kind: "currency_not_covered" };
    candidates = ofCurrency.filter((policy) => policyCoversAmount(policy, amount));
  } else {
    candidates = [...activePolicies];
  }
  if (candidates.length === 0) return { kind: "none" };
  const [strictest] = [...candidates].sort(
    (a, b) =>
      b.requiredApprovals - a.requiredApprovals ||
      (a.minAmountMinor === b.minAmountMinor ? 0 : a.minAmountMinor > b.minAmountMinor ? -1 : 1) ||
      a.id.localeCompare(b.id),
  );
  return { kind: "policy", policy: strictest };
}

export type ApprovalTally = "PENDING" | "APPROVED" | "REJECTED";

/**
 * What the decisions so far mean (§21.3): any REJECT ends the request as REJECTED; it is APPROVED once `requiredApprovals`
 * DIFFERENT people approved (one decision per person is guaranteed by a unique index); otherwise it stays PENDING.
 */
export function tallyDecisions(requiredApprovals: number, decisions: ReadonlyArray<{ deciderId: string; decision: ApprovalDecisionKindValue }>): ApprovalTally {
  if (decisions.some((row) => row.decision === "REJECT")) return "REJECTED";
  const approvers = new Set(decisions.filter((row) => row.decision === "APPROVE").map((row) => row.deciderId));
  return approvers.size >= requiredApprovals ? "APPROVED" : "PENDING";
}

/** Has the request passed its `expiresAt`? A request without one never expires. */
export function hasExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

/** `now + hours`, or null when the policy has no expiry. */
export function expiryFrom(now: Date, expiresAfterHours: number | null): Date | null {
  return expiresAfterHours === null ? null : new Date(now.getTime() + expiresAfterHours * 3_600_000);
}

/** Values a request's `details` may hold: ids, codes, whole numbers, decimal-string amounts, booleans, null. */
export type ApprovalDetailValue = string | number | boolean | null;
export type ApprovalDetails = Record<string, ApprovalDetailValue>;

const DETAIL_KEY = /^[a-z][A-Za-z0-9]{0,39}$/;
/** Identifiers, codes and decimal digits; no spaces, so names, emails and notes cannot be stored (ids only, §22.2). */
const DETAIL_STRING = /^-?[A-Za-z0-9_.:-]{1,64}$/;
const MAX_DETAILS = 20;

/**
 * Normalizes and checks the `details` a subject module snapshots for the approver (a cost version's old and new unit cost,
 * a refund's payment id, ...). Flat object only; `bigint` amounts become decimal strings (docs/API_CONVENTIONS.md "Money").
 * @returns the JSON-safe details, or a human-readable problem.
 */
export function normalizeApprovalDetails(details: Record<string, unknown>): { ok: true; details: ApprovalDetails } | { ok: false; problem: string } {
  const entries = Object.entries(details);
  if (entries.length > MAX_DETAILS) return { ok: false, problem: `at most ${MAX_DETAILS} details are allowed` };
  const result: ApprovalDetails = {};
  for (const [key, value] of entries) {
    if (!DETAIL_KEY.test(key)) return { ok: false, problem: `detail "${key}" must be a camelCase name` };
    if (value === null || typeof value === "boolean") result[key] = value;
    else if (typeof value === "bigint") result[key] = value.toString();
    else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) return { ok: false, problem: `detail "${key}" must be a whole number (pass amounts as bigint)` };
      result[key] = value;
    } else if (typeof value === "string") {
      if (!DETAIL_STRING.test(value)) return { ok: false, problem: `detail "${key}" must be an id, code or number, not free text` };
      result[key] = value;
    } else {
      return { ok: false, problem: `detail "${key}" must be a string, number, bigint, boolean or null` };
    }
  }
  return { ok: true, details: result };
}
