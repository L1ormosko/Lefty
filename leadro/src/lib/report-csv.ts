import { createHash } from "node:crypto";
import { wallMsAt } from "./zoned-time";

/**
 * Pure helpers for report exports (spec 13.5): CSV encoding with formula-injection escaping, money as decimal strings
 * per currency, instants in the tenant's zone, and the canonical JSON behind a filters hash. No Prisma, no Next.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula (or, for tab / CR, let a cell smuggle one in after
 * re-parsing). A text cell starting with one of them gets a leading apostrophe (OWASP "CSV injection"), which spreadsheet
 * applications show as plain text.
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/** Does this text start like a spreadsheet formula? */
export function startsLikeFormula(text: string): boolean {
  return FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * One CSV field. `neutralizeFormula` is true for text that came from people (names, titles, references): such a value
 * is prefixed with `'` when it starts like a formula. Server-formatted numbers, money and dates pass `false`, so a
 * negative amount stays a number. Fields with a comma, quote or line break are quoted (RFC 4180).
 */
export function csvField(value: string, neutralizeFormula: boolean): string {
  const text = neutralizeFormula && startsLikeFormula(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 byte order mark: spreadsheet applications need it to read non-ASCII text (es-US, he-IL) correctly. */
export const CSV_BOM = "﻿";

/** A whole CSV document: BOM, header line, rows; CRLF line endings (RFC 4180). Fields must already be encoded. */
export function toCsvDocument(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [header.join(","), ...rows.map((row) => row.join(","))];
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

const fractionDigitsCache = new Map<string, number>();

/** Minor-unit digits of an ISO 4217 currency (USD 2, JPY 0, KWD 3), from the platform's currency data. */
export function currencyFractionDigits(currency: string): number {
  let digits = fractionDigitsCache.get(currency);
  if (digits === undefined) {
    digits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    fractionDigitsCache.set(currency, digits);
  }
  return digits;
}

/**
 * Integer minor units as a plain decimal string in major units of the currency: `12345n, "USD"` -> `"123.45"`,
 * `-5n, "USD"` -> `"-0.05"`, `500n, "JPY"` -> `"500"`. Exact (bigint arithmetic, no float), no grouping, no symbol
 * (§11.8, API_CONVENTIONS "Money").
 */
export function formatMinorUnits(minor: bigint, currency: string): string {
  const digits = currencyFractionDigits(currency);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  if (digits === 0) return `${negative ? "-" : ""}${absolute}`;
  const scale = 10n ** BigInt(digits);
  const fraction = (absolute % scale).toString().padStart(digits, "0");
  return `${negative ? "-" : ""}${absolute / scale}.${fraction}`;
}

const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, "0");

/**
 * An instant as ISO-8601 local time in `zone` with its UTC offset, second precision:
 * `2026-03-10T10:00:00-05:00`. Same instant as the stored UTC value, shown the way the tenant reads its clock (§16.5).
 */
export function formatInstantInZone(instant: Date, zone: string): string {
  const instantMs = Math.floor(instant.getTime() / 1000) * 1000;
  const wallMs = wallMsAt(instantMs, zone);
  const offsetMinutes = Math.round((wallMs - instantMs) / 60_000);
  const local = new Date(wallMs).toISOString().slice(0, 19);
  const sign = offsetMinutes < 0 ? "-" : "+";
  return `${local}${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
}

/** JSON with object keys sorted at every level, so equal filters always produce the same text (and hash). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex of the canonical JSON of `filters` (`ReportExport.filtersHash`). */
export function filtersHash(filters: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(filters)).digest("hex");
}
