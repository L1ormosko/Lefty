import { Select, TextInput } from "@/components/ui";
import type { TranslateFn } from "@/lib/i18n";
import { AdminField } from "../../../_components/AdminField";
import { WEEKDAYS, hoursFieldName } from "../../../_lib/branch-form";
import { knownTimeZones, localeOptions } from "../../../_lib/format";

/** Current values of a branch, as stored (all optional: a new branch starts empty). */
export interface BranchDefaults {
  name?: string;
  code?: string | null;
  address?: Record<string, unknown> | null;
  timeZone?: string | null;
  defaultLocale?: string | null;
  operatingHours?: Record<string, { open?: string; close?: string } | null> | null;
}

/**
 * The branch form body shared by "Add branch" and "Edit branch": identity, address, time zone,
 * language and opening hours. `idPrefix` keeps ids unique when several dialogs exist on one page.
 */
export function BranchFields({ t, idPrefix, defaults = {}, withName = true }: { t: TranslateFn; idPrefix: string; defaults?: BranchDefaults; withName?: boolean }) {
  const address = (defaults.address ?? {}) as Record<string, string | undefined>;
  const text = (name: string, label: string, value: string | null | undefined, extra: { required?: boolean; max?: number; ltr?: boolean } = {}) => (
    <AdminField label={label} htmlFor={`${idPrefix}-${name}`} required={extra.required}>
      <TextInput id={`${idPrefix}-${name}`} name={name} defaultValue={value ?? ""} required={extra.required} maxLength={extra.max} dir={extra.ltr ? "ltr" : undefined} />
    </AdminField>
  );
  return (
    <>
      {withName ? text("name", t("ADMIN.ORG_UNIT_NAME"), defaults.name, { required: true, max: 120 }) : null}
      {text("code", t("ADMIN.ORG_UNIT_CODE"), defaults.code, { max: 40, ltr: true })}
      <fieldset className="space-y-3 rounded border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{t("ADMIN.BRANCH_ADDRESS")}</legend>
        {text("addressLine1", t("ADMIN.BRANCH_ADDRESS_LINE1"), address.line1, { max: 200 })}
        {text("addressLine2", t("ADMIN.BRANCH_ADDRESS_LINE2"), address.line2, { max: 200 })}
        {text("addressCity", t("ADMIN.BRANCH_CITY"), address.city, { max: 100 })}
        <div className="grid grid-cols-2 gap-3">
          {text("addressState", t("ADMIN.BRANCH_STATE_CODE"), address.state, { max: 2, ltr: true })}
          {text("addressPostalCode", t("ADMIN.BRANCH_POSTAL_CODE"), address.postalCode, { max: 10, ltr: true })}
        </div>
      </fieldset>
      <AdminField label={t("ADMIN.COMPANY_TIME_ZONE")} htmlFor={`${idPrefix}-timeZone`} hint={t("ADMIN.COMPANY_TIME_ZONE_HINT")}>
        <TextInput id={`${idPrefix}-timeZone`} name="timeZone" list={`${idPrefix}-zones`} defaultValue={defaults.timeZone ?? ""} dir="ltr" />
        <datalist id={`${idPrefix}-zones`}>
          {knownTimeZones().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </AdminField>
      <AdminField label={t("COMMON.LANGUAGE")} htmlFor={`${idPrefix}-locale`}>
        <Select id={`${idPrefix}-locale`} name="defaultLocale" defaultValue={defaults.defaultLocale ?? ""} options={localeOptions(t)} placeholder={t("ADMIN.BRANCH_INHERIT")} />
      </AdminField>
      <fieldset className="space-y-2 rounded border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{t("ADMIN.BRANCH_HOURS")}</legend>
        <p className="text-xs text-ink-muted">{t("ADMIN.BRANCH_HOURS_HINT")}</p>
        {WEEKDAYS.map((day) => {
          const hours = defaults.operatingHours?.[day] ?? null;
          return (
            <div key={day} className="grid grid-cols-[6rem_1fr_1fr] items-center gap-2 text-sm">
              <span>{t(`ADMIN.WEEKDAY_${day.toUpperCase()}`)}</span>
              <TextInput type="time" name={hoursFieldName(day, "open")} defaultValue={hours?.open ?? ""} aria-label={`${t(`ADMIN.WEEKDAY_${day.toUpperCase()}`)} ${t("ADMIN.BRANCH_OPENS")}`} />
              <TextInput type="time" name={hoursFieldName(day, "close")} defaultValue={hours?.close ?? ""} aria-label={`${t(`ADMIN.WEEKDAY_${day.toUpperCase()}`)} ${t("ADMIN.BRANCH_CLOSES")}`} />
            </div>
          );
        })}
      </fieldset>
    </>
  );
}
