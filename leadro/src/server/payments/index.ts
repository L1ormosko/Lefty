// Payment records (spec 11.1): manual recording, status changes, reads
export { recordManualPayment } from "./record";
export { markPaymentFailed, markPaymentReceived, voidPayment } from "./status";
export { getPayment, listPayments, paymentResourceRef } from "./read";
export { createPaymentIdempotently, postPaymentReceivedInTx, toPaymentView } from "./store";
export type { PaymentView } from "./store";

// Revenue from outcomes: finance-confirmed charges and collections
export { confirmOutcomeCharge, confirmOutcomeCollection, listChargesToConfirm } from "./outcome-revenue";
export type { ChargeToConfirmView, ConfirmedCharge } from "./outcome-revenue";

// Payment provider boundary (not configured) and the authenticated intake
export {
  PAYMENT_PROVIDER_NOT_CONFIGURED,
  configuredPaymentProviders,
  getPaymentProvider,
  hmacSha256Matches,
  registerPaymentProvider,
  resetPaymentProviders,
} from "./provider";
export type { ParseResult, PaymentProvider, ProviderEvent, VerifyRequest } from "./provider";
export { INTAKE_SYSTEM_ACTOR, receiveProviderEvent } from "./intake";
export { registerIntakeEventHandler } from "./intake-handlers";
export type { IntakeEventHandler, IntakeEventInput, IntakeVerdict } from "./intake-handlers";
export type { IntakeRequest, IntakeResult } from "./intake";
export { listIntakeEvents, listPaymentProviders } from "./intake-read";
export type { IntakeEventView } from "./intake-read";

export {
  PAYMENT_METHODS,
  METHODS_NEEDING_REFERENCE,
  chargesToConfirmQuerySchema,
  confirmChargeSchema,
  confirmCollectionSchema,
  intakeParams,
  listIntakeEventsQuerySchema,
  listPaymentsQuerySchema,
  markReceivedSchema,
  outcomeIdParams,
  paymentIdParams,
  reasonSchema,
  recordPaymentSchema,
} from "./schemas";
export type {
  ChargesToConfirmQuery,
  ConfirmChargeInput,
  ConfirmCollectionInput,
  ListIntakeEventsQuery,
  ListPaymentsQuery,
  MarkReceivedInput,
  PaymentMethodValue,
  ReasonInput,
  RecordPaymentInput,
} from "./schemas";
