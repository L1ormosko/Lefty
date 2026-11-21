import { createTranslator, type TranslateFn } from "@/lib/i18n";
import { resolveLocaleContext, type LocaleContext, type LocaleContextRequest } from "./locale-context";
import { loadReviewedOverrides } from "./overrides";

/**
 * One-call helper for server code (API error messages, emails, server components): resolves the
 * locale context and builds a translator that includes the tenant's reviewed overrides.
 */
export async function getTranslatorForRequest(
  tenantId: string,
  request: LocaleContextRequest = {},
): Promise<{ t: TranslateFn; context: LocaleContext }> {
  const [context, overrides] = await Promise.all([resolveLocaleContext(tenantId, request), loadReviewedOverrides(tenantId)]);
  return { t: createTranslator({ localeChain: context.localeChain, overrides }), context };
}
