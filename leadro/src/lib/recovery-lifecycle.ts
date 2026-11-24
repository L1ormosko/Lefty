/**
 * The recovery case status machine (§9.5). Pure: the ONE place that says which changes are allowed.
 *
 *   NEW -> ASSIGNED -> CONTACTING -> CUSTOMER_REACHED -> FOLLOW_UP_REQUIRED
 *                          \____________\_________________\___-> RECOVERED -> CLOSED
 *                                                          \___-> NOT_RECOVERED -> CLOSED (or reopened to CONTACTING)
 *
 * NOT_RECOVERED and CLOSED carry `closedAt` (database CHECK); RECOVERED carries `recoveredAt` and the confirmed result.
 * CLOSED is final.
 */

export const RECOVERY_STATUSES = ["NEW", "ASSIGNED", "CONTACTING", "CUSTOMER_REACHED", "FOLLOW_UP_REQUIRED", "RECOVERED", "NOT_RECOVERED", "CLOSED"] as const;
export type RecoveryStatusValue = (typeof RECOVERY_STATUSES)[number];

export const RECOVERY_TRANSITIONS: Readonly<Record<RecoveryStatusValue, readonly RecoveryStatusValue[]>> = {
  NEW: ["ASSIGNED", "CONTACTING", "CLOSED"],
  ASSIGNED: ["NEW", "CONTACTING", "CUSTOMER_REACHED", "FOLLOW_UP_REQUIRED", "NOT_RECOVERED", "CLOSED"],
  CONTACTING: ["CUSTOMER_REACHED", "FOLLOW_UP_REQUIRED", "RECOVERED", "NOT_RECOVERED", "CLOSED"],
  CUSTOMER_REACHED: ["CONTACTING", "FOLLOW_UP_REQUIRED", "RECOVERED", "NOT_RECOVERED"],
  FOLLOW_UP_REQUIRED: ["CONTACTING", "CUSTOMER_REACHED", "RECOVERED", "NOT_RECOVERED", "CLOSED"],
  RECOVERED: ["CLOSED"],
  NOT_RECOVERED: ["CONTACTING", "CLOSED"],
  CLOSED: [],
};

export const isRecoveryStatus = (value: string): value is RecoveryStatusValue => (RECOVERY_STATUSES as readonly string[]).includes(value);

export const canTransitionRecovery = (from: RecoveryStatusValue, to: RecoveryStatusValue): boolean => RECOVERY_TRANSITIONS[from].includes(to);

export const nextRecoveryStatuses = (from: RecoveryStatusValue): readonly RecoveryStatusValue[] => RECOVERY_TRANSITIONS[from];

/** Statuses with a closing time (matches the table CHECK). */
export const isClosedRecoveryStatus = (status: RecoveryStatusValue): boolean => status === "NOT_RECOVERED" || status === "CLOSED";

/** Open work: shown in queues. */
export const isOpenRecoveryStatus = (status: RecoveryStatusValue): boolean => !isClosedRecoveryStatus(status) && status !== "RECOVERED";
