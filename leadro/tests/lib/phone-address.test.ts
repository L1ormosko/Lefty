import { describe, expect, it } from "vitest";
import { normalizeAddressKey } from "@/lib/address-key";
import { normalizePhoneE164, phoneSearchDigits } from "@/lib/phone";

describe("normalizePhoneE164", () => {
  it.each([
    ["(555) 123-4567", "+15551234567"],
    ["555.123.4567", "+15551234567"],
    ["1-555-123-4567", "+15551234567"],
    ["+1 555 123 4567", "+15551234567"],
    ["+972 50-123-4567", "+972501234567"],
    ["00972501234567", "+972501234567"],
    ["555 123 4567 x89", "+15551234567"],
    ["555 123 4567 ext. 12", "+15551234567"],
  ])("normalizes %s to %s", (raw, expected) => {
    expect(normalizePhoneE164(raw)).toBe(expected);
  });

  it.each(["", "abc", "12", "0123456", "555-1234", "+0123456789", "+1234567890123456", "(555) 123-45678"])(
    "refuses %s instead of guessing a country",
    (raw) => {
      expect(normalizePhoneE164(raw)).toBeNull();
    },
  );

  it("two formats of one number give the same key (the duplicate match relies on it)", () => {
    expect(normalizePhoneE164("(555) 123-4567")).toBe(normalizePhoneE164("+1 555-123-4567"));
  });
});

describe("phoneSearchDigits", () => {
  it("returns the digits of a phone-looking fragment", () => {
    expect(phoneSearchDigits("555-12")).toBe("55512");
    expect(phoneSearchDigits("(555) 987")).toBe("555987");
  });

  it("does not treat names, short numbers or mixed text as a phone search", () => {
    expect(phoneSearchDigits("Unit 5")).toBeNull();
    expect(phoneSearchDigits("12")).toBeNull();
    expect(phoneSearchDigits("smith")).toBeNull();
  });
});

describe("normalizeAddressKey", () => {
  const base = { line1: "12 Main St.", city: "Springfield", region: "IL", postalCode: "62701", countryCode: "US" };

  it("ignores case, punctuation and repeated spaces", () => {
    expect(normalizeAddressKey(base)).toBe("12 main st||springfield|il|62701|us");
    expect(normalizeAddressKey({ ...base, line1: "  12   MAIN st ", city: "SPRINGFIELD", region: "il" })).toBe(normalizeAddressKey(base));
  });

  it("matches a US ZIP+4 with the plain ZIP, and other postal codes without spaces", () => {
    expect(normalizeAddressKey({ ...base, postalCode: "62701-1234" })).toBe(normalizeAddressKey(base));
    expect(normalizeAddressKey({ ...base, countryCode: "GB", postalCode: "SW1A 1AA" })).toBe(normalizeAddressKey({ ...base, countryCode: "GB", postalCode: "sw1a1aa" }));
  });

  it("keeps different units apart (an apartment is not the same dwelling)", () => {
    expect(normalizeAddressKey({ ...base, line2: "Apt 4" })).not.toBe(normalizeAddressKey({ ...base, line2: "Apt 5" }));
    expect(normalizeAddressKey({ ...base, line2: "Apt #4" })).toBe(normalizeAddressKey({ ...base, line2: "apt 4" }));
  });

  it("does not expand abbreviations (a deliberate, conservative choice)", () => {
    expect(normalizeAddressKey({ ...base, line1: "12 Main Street" })).not.toBe(normalizeAddressKey(base));
  });
});
