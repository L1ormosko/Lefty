// Recording and correcting visit outcomes (§9.1)
export { recordJobOutcome, recordOutcomeInTx } from "./record";
export type { RecordedOutcome, RecordOutcomeInTxResult } from "./record";
export { correctJobOutcome, getOutcomeCorrections } from "./correct";
export type { OutcomeCorrectionView } from "./correct";
export { getJobOutcome, listJobOutcomes } from "./read";

// Lost reasons (§9.2)
export { listLostReasons, getLostReason, createLostReason, updateLostReason } from "./lost-reasons";

// The domain event the recovery engine subscribes to, and notification wiring
export { onJobOutcomeRecorded, resetJobOutcomeHandlers } from "./events";
export type { OutcomeRecordedEvent, OutcomeRecordedHandler } from "./events";
export { registerJobOutcomeNotificationTarget, outcomeResourceRef } from "./notify";

export {
  jobIdParams,
  outcomeIdParams,
  lostReasonIdParams,
  recordOutcomeSchema,
  correctOutcomeSchema,
  listOutcomesQuerySchema,
  createLostReasonSchema,
  updateLostReasonSchema,
  listLostReasonsQuerySchema,
} from "./schemas";
export type { RecordOutcomeInput, CorrectOutcomeInput, ListOutcomesQuery, CreateLostReasonInput, UpdateLostReasonInput, ListLostReasonsQuery } from "./schemas";
