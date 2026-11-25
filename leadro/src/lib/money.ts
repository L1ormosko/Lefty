import { z } from "zod";

/**
 * Money (spec 11.8): integer minor units + an ISO 4217 currency, never floats.
 *
 * Convention (docs/API_CONVENTIONS.md "Money"):
 * - Storage: `BigInt` columns; in server code an amount is a `bigint` and all arithmetic is BigInt arithmetic.
 * - API responses: a minor-unit amount is a DECIMAL STRING (`"125000"`), because JSON numbers above 2^53 lose precision
 *   and `JSON.stringify` rejects `bigint`. `stringifyJson` / `serializeJson` below do it for every response and every
 *   stored JSON value.
 * - API requests: an amount may be a JSON integer (when it is a safe integer) or a decimal string; both parse to `bigint`.
 */

/** Largest amount an API accepts: 999,999,999,999,999 minor units (about 10 trillion major units); below 2^53 on purpose. */
export const MAX_MONEY_MINOR = 999_999_999_999_999n;

const UNSIGNED = /^(0|[1-9][0-9]{0,15})$/;
const SIGNED = /^-?(0|[1-9][0-9]{0,15})$/;

function parseAmount(value: number | string, pattern: RegExp, context: z.RefinementCtx): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (!pattern.test(text)) {
    context.addIssue({ code: "custom", message: "Expected a whole number of minor units" });
    return z.NEVER;
  }
  const amount = BigInt(text);
  if (amount > MAX_MONEY_MINOR || amount < -MAX_MONEY_MINOR) {
    context.addIssue({ code: "custom", message: "Amount is out of range" });
    return z.NEVER;
  }
  return amount;
}

const amountInput = z.union([z.number().int().safe(), z.string().trim()]);

/** A non-negative amount in minor units: JSON integer or decimal string in, `bigint` out. */
export const moneyAmountSchema = amountInput.transform((value, context) => parseAmount(value, UNSIGNED, context));

/** A signed amount (ledger adjustments, deltas): JSON integer or decimal string in, `bigint` out. */
export const signedMoneyAmountSchema = amountInput.transform((value, context) => parseAmount(value, SIGNED, context));

/** ISO 4217 shape only (three upper-case letters); the set of currencies a tenant uses is tenant configuration. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code");

/** JSON replacer that writes `bigint` as a decimal string. */
function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** `JSON.stringify` that is safe for money: every `bigint` becomes a decimal string. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, bigintToString);
}

/** A deep JSON-safe copy of `value` (`bigint` -> decimal string, Dates -> ISO). Use before storing or returning plain JSON. */
export function serializeJson<T = unknown>(value: unknown): T {
  return JSON.parse(stringifyJson(value)) as T;
}

/** Exact sum of amounts; null / undefined count as zero. */
export function sumMinor(values: Iterable<bigint | null | undefined>): bigint {
  let total = 0n;
  for (const value of values) total += value ?? 0n;
  return total;
}
