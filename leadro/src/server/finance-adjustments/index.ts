// Refunds against received payments (request -> approval per policy -> paid out = REFUND entry)
export { requestRefund, completeRefund, cancelRefund, listRefunds, getRefund, refundResourceRef } from "./refunds";
export type { RefundView, RequestedRefund } from "./refunds";

// Adjustments: credits / debits on a job with a reason (approval per policy -> ADJUSTMENT entry)
export { requestAdjustment, cancelAdjustment, listAdjustments, getAdjustment, adjustmentResourceRef } from "./adjustments";
export type { AdjustmentView, RequestedAdjustment } from "./adjustments";

// Chargebacks: manual or provider intake (CHARGEBACK entry), dispute, won (reversal), lost, write-off via approval
export {
  recordChargeback,
  disputeChargeback,
  markChargebackWon,
  markChargebackLost,
  requestChargebackWriteOff,
  listChargebacks,
  getChargeback,
  chargebackResourceRef,
} from "./chargebacks";
export type { ChargebackView } from "./chargebacks";

// Finance review flags (raised by other money / job changes, or by a person) and their workflow
export {
  raiseFinanceReviewFlagInTx,
  raiseManualFlag,
  assignReviewFlag,
  unassignReviewFlag,
  resolveReviewFlag,
  listReviewFlags,
  getReviewFlag,
  reviewFlagResourceRef,
} from "./review-flags";
export type { FlagRefs, FlagView, RaiseFlagInTxInput } from "./review-flags";

// Wiring (approval subjects, provider chargebacks, job-reopened / outcome-corrected / ledger-correction reactions)
export { registerFinanceAdjustments } from "./wiring";
export { FINANCE_REVIEW_SYSTEM_ACTOR } from "./common";
export { reviewFlagKeys } from "./keys";

export {
  financeIdParams,
  requestRefundSchema,
  completeRefundSchema,
  reasonSchema,
  listRefundsQuerySchema,
  requestAdjustmentSchema,
  listAdjustmentsQuerySchema,
  recordChargebackSchema,
  chargebackNotesSchema,
  listChargebacksQuerySchema,
  raiseFlagSchema,
  assignFlagSchema,
  resolveFlagSchema,
  listFlagsQuerySchema,
} from "./schemas";
export type {
  RequestRefundInput,
  CompleteRefundInput,
  ReasonInput,
  ListRefundsQuery,
  RequestAdjustmentInput,
  ListAdjustmentsQuery,
  RecordChargebackInput,
  ChargebackNotesInput,
  ListChargebacksQuery,
  RaiseFlagInput,
  AssignFlagInput,
  ResolveFlagInput,
  ListFlagsQuery,
} from "./schemas";

import { registerFinanceAdjustments } from "./wiring";

// Loading the module plugs REFUND / ADJUSTMENT / CHARGEBACK_WRITE_OFF, the chargeback intake and the reactions in (idempotent).
registerFinanceAdjustments();
