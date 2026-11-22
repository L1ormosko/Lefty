/**
 * The duplicate-address matching key of a customer address (§6.4): `line1|line2|city|region|postal|country`,
 * lower-case, punctuation removed, whitespace collapsed. Pure: no Prisma, no Next.
 *
 * Deliberately conservative: it makes "12 Main St." and "12  main st" equal but does NOT expand
 * abbreviations ("St" vs "Street") or guess apartment formats, because a false match would flag
 * unrelated customers. Matching only flags for a human, never merges, so a miss costs less than noise.
 */

export interface AddressKeyParts {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

const collapse = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,#'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** US ZIP+4 ("30301-1234") matches the plain ZIP; other postal codes only lose spaces ("SW1A 1AA" = "sw1a1aa"). */
function normalizePostalCode(value: string, countryCode: string): string {
  const compact = collapse(value).replace(/\s/g, "");
  if (countryCode.toUpperCase() === "US") return compact.replace(/^(\d{5})-\d{4}$/, "$1");
  return compact;
}

export function normalizeAddressKey(address: AddressKeyParts): string {
  return [
    collapse(address.line1),
    collapse(address.line2 ?? ""),
    collapse(address.city),
    collapse(address.region),
    normalizePostalCode(address.postalCode, address.countryCode),
    address.countryCode.trim().toLowerCase(),
  ].join("|");
}
