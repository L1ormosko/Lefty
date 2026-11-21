export { resolveLocaleContext } from "./locale-context";
export type { LocaleContext, LocaleContextRequest } from "./locale-context";
export {
  loadReviewedOverrides,
  TranslationOverrideError,
} from "./overrides";
// The ungated saveOverride / markOverrideReviewed / deleteOverride stay module-private on purpose: callers
// outside this module must use the permission-checked `*AsActor` functions.
export type { OverrideInput } from "./overrides";
export { getTranslatorForRequest } from "./translator-for-request";
export { saveOverrideAsActor, reviewOverrideAsActor, deleteOverrideAsActor, toAppError } from "./override-admin";
