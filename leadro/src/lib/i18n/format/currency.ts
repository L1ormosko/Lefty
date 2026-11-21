import type { Locale } from "../locales";

export interface CurrencyFormatOptions {
  locale: Locale;
  /** ISO 4217 code. Only USD is used in v1 (§11.8), but nothing here is USD-specific. */
  currency?: string;
}

/**
 * Formats an amount stored as integer MINOR units (cents) — §11.8: money is never a float.
 *
 * The cents are converted to a decimal STRING ("12.34") and passed to Intl, which accepts exact
 * decimal strings, so large `bigint` amounts keep full precision and no float division happens.
 */
export function formatMoneyFromMinorUnits(
  minorUnits: bigint | number,
  { locale, currency = "USD" }: CurrencyFormatOptions,
): string {
  if (typeof minorUnits === "number" && !Number.isSafeInteger(minorUnits)) {
    throw new RangeError("Money must be an integer number of minor units");
  }
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(minorUnitsToDecimalString(BigInt(minorUnits), digits) as unknown as number);
}

/** 1234n, 2 → "12.34"; -5n, 2 → "-0.05"; 700n, 0 → "700". */
export function minorUnitsToDecimalString(minorUnits: bigint, fractionDigits: number): string {
  const negative = minorUnits < 0n;
  const absolute = (negative ? -minorUnits : minorUnits).toString().padStart(fractionDigits + 1, "0");
  const whole = absolute.slice(0, absolute.length - fractionDigits);
  const fraction = absolute.slice(absolute.length - fractionDigits);
  const text = fractionDigits > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${text}` : text;
}
