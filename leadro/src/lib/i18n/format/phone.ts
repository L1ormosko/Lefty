const E164 = /^\+[1-9]\d{6,14}$/;
const NANP = /^\+1(\d{3})(\d{3})(\d{4})$/;

/** True for a syntactically valid E.164 number: "+" then 7–15 digits, no leading zero country code. */
export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Display form of an E.164 number. Phones are STORED as E.164 (§16.5); this only formats for
 * reading. US/Canada (+1) numbers get "+1 (212) 555-0123"; every other country is shown as the
 * unchanged E.164 string, because correct national grouping needs per-country rules we do not
 * ship (no dependency, no guessing). Throws on non-E.164 input so bad data is not hidden.
 */
export function formatPhone(e164: string): string {
  if (!isE164(e164)) throw new RangeError("Phone number must be in E.164 format, e.g. +12125550123");
  const match = NANP.exec(e164);
  return match ? `+1 (${match[1]}) ${match[2]}-${match[3]}` : e164;
}
