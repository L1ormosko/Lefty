/**
 * Translating the branch form (flat inputs) into the shapes `createOrgUnitSchema` /
 * `updateOrgUnitSchema` accept. Pure functions: no Next, no database.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

type FormValues = Record<string, string | undefined>;

/** Field names of the hours inputs: `hours_mon_open`, `hours_mon_close`, ... */
export const hoursFieldName = (day: Weekday, edge: "open" | "close"): string => `hours_${day}_${edge}`;

/**
 * Opening hours from the form. A day with both times is open; a day with neither is closed
 * (`null`); a day with only one time is passed through half-filled so the service's own
 * validation rejects it instead of this function guessing.
 */
export function operatingHoursFromForm(values: FormValues): Record<string, { open?: string; close?: string } | null> | undefined {
  const hours: Record<string, { open?: string; close?: string } | null> = {};
  let anyDay = false;
  for (const day of WEEKDAYS) {
    const open = values[hoursFieldName(day, "open")];
    const close = values[hoursFieldName(day, "close")];
    if (open || close) anyDay = true;
    hours[day] = open || close ? { open, close } : null;
  }
  return anyDay ? hours : undefined;
}

/** The address object, or `undefined` when the whole address block was left blank. */
export function addressFromForm(values: FormValues): Record<string, string | undefined> | undefined {
  const address = {
    line1: values.addressLine1,
    line2: values.addressLine2,
    city: values.addressCity,
    state: values.addressState,
    postalCode: values.addressPostalCode,
  };
  return Object.values(address).some(Boolean) ? address : undefined;
}

/**
 * Branch attributes for a CREATE: only what the user filled in.
 */
export function branchAttributesForCreate(values: FormValues) {
  return {
    address: addressFromForm(values),
    timeZone: values.timeZone,
    defaultLocale: values.defaultLocale,
    operatingHours: operatingHoursFromForm(values),
  };
}

/**
 * Branch attributes for an EDIT. The form always shows the current values, so a blank block means
 * "clear it" (`null`), which is how the update schema expresses removal.
 */
export function branchAttributesForUpdate(values: FormValues) {
  return {
    address: addressFromForm(values) ?? null,
    timeZone: values.timeZone ?? null,
    defaultLocale: values.defaultLocale ?? null,
    operatingHours: operatingHoursFromForm(values) ?? null,
  };
}
