import { Checkbox, Select } from "@/components/ui";
import type { TranslateFn } from "@/lib/i18n";
import { GRANTABLE_SCOPE_TYPES } from "../_lib/invite-form";
import { AdminField } from "./AdminField";

type Option = { value: string; label: string };

/**
 * The data-scope part of a role grant (invitation or assignment): which scope type, and the unit or
 * legal entity it applies to. A role always needs a scope; there is no "everything" default. The
 * server action reads `scopeType`, `scopeOrgUnitId`, `scopeLegalEntityId`, `scopeThisUnitOnly`.
 */
export function ScopeFields({ t, idPrefix, unitOptions, legalEntityOptions, required }: { t: TranslateFn; idPrefix: string; unitOptions: Option[]; legalEntityOptions: Option[]; required?: boolean }) {
  return (
    <fieldset className="space-y-3 rounded border border-line p-3">
      <legend className="px-1 text-sm font-semibold">{t("ADMIN.SCOPE_TITLE")}</legend>
      <p className="text-xs text-ink-muted">{t("ADMIN.SCOPE_HELP")}</p>
      <AdminField label={t("ADMIN.SCOPE_TYPE")} htmlFor={`${idPrefix}-scope-type`} required={required}>
        <Select
          id={`${idPrefix}-scope-type`}
          name="scopeType"
          required={required}
          placeholder={t("ADMIN.CHOOSE")}
          options={GRANTABLE_SCOPE_TYPES.map((type) => ({ value: type, label: t(`ADMIN.SCOPE_TYPE_${type}`) }))}
        />
      </AdminField>
      <AdminField label={t("ADMIN.SCOPE_ORG_UNIT")} htmlFor={`${idPrefix}-scope-unit`} hint={t("ADMIN.SCOPE_TARGET_HINT")}>
        <Select id={`${idPrefix}-scope-unit`} name="scopeOrgUnitId" options={unitOptions} placeholder={t("ADMIN.NONE")} />
      </AdminField>
      <Checkbox name="scopeThisUnitOnly" label={t("ADMIN.SCOPE_THIS_UNIT_ONLY")} />
      <AdminField label={t("ADMIN.SCOPE_LEGAL_ENTITY")} htmlFor={`${idPrefix}-scope-entity`} hint={t("ADMIN.SCOPE_TARGET_HINT")}>
        <Select id={`${idPrefix}-scope-entity`} name="scopeLegalEntityId" options={legalEntityOptions} placeholder={t("ADMIN.NONE")} />
      </AdminField>
    </fieldset>
  );
}
