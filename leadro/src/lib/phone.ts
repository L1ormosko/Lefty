/**
 * Phone number normalization to E.164 (`+15551234567`), the match and search key of customers and
 * leads (§6.4). Pure: no Prisma, no Next.
 *
 * Rules (documented in docs/DECISIONS.md "Phase 2 Task 2"):
 *  - a leading `+` means the number is already international: keep its digits as-is;
 *  - `00` is the international call prefix and is read like `+`;
 *  - otherwise treat it as a North American number (the launch market, §1.2): 10 digits get `+1`,
 *    11 digits starting with `1` get `+`;
 *  - anything else cannot be normalized without guessing a country, so it is rejected and the user
 *    is asked for the international form.
 * Extensions ("x123", "ext. 5") are not part of the key: they are cut off before normalizing.
 */

/** The database CHECK (`customer_phone_e164`): + then 7 to 15 digits, first digit not zero. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Returns the E.164 form, or `null` when the input cannot be normalized unambiguously. */
export function normalizePhoneE164(raw: string): string | null {
  const trimmed = raw.replace(/\s*(?:ext\.?|x)\s*\d+\s*$/i, "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  let candidate: string;
  if (trimmed.startsWith("+")) candidate = `+${digits}`;
  else if (trimmed.startsWith("00") && digits.length > 2) candidate = `+${digits.slice(2)}`;
  else if (digits.length === 10) candidate = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
  else return null;

  return E164.test(candidate) ? candidate : null;
}

/**
 * The digits of a free-text search term, for partial phone search ("555-12" finds "+15551234567").
 * Returns `null` unless the term looks like a phone fragment (digits plus phone punctuation only,
 * at least 3 digits), so a name search such as "Unit 5" is never treated as a phone search.
 */
export function phoneSearchDigits(term: string): string | null {
  if (!/^[+0-9 ()\-.]+$/.test(term)) return null;
  const digits = term.replace(/\D/g, "");
  return digits.length >= 3 ? digits : null;
}
