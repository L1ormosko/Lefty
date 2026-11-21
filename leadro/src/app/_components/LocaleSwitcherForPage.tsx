import { SUPPORTED_LOCALES, type MessageKey } from "@/lib/i18n";
import { getPageContext } from "../_lib/page-context";
import { LanguageSwitcher } from "./LanguageSwitcher";

const LOCALE_LABEL_KEYS: Record<(typeof SUPPORTED_LOCALES)[number], MessageKey> = {
  "en-US": "LOCALE.EN_US",
  "es-US": "LOCALE.ES_US",
  "he-IL": "LOCALE.HE_IL",
};

/** Server wrapper: builds the translated option list for the current request's locale. */
export async function LocaleSwitcherForPage() {
  const { locale, t } = await getPageContext();
  return (
    <LanguageSwitcher
      label={t("COMMON.LANGUAGE")}
      currentLocale={locale}
      options={SUPPORTED_LOCALES.map((value) => ({ value, label: t(LOCALE_LABEL_KEYS[value]) }))}
    />
  );
}
