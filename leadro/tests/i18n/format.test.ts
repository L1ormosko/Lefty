import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDateTimeWithZone,
  formatMoneyFromMinorUnits,
  formatNumber,
  formatPercent,
  formatPhone,
  formatTime,
  isolateLtr,
  minorUnitsToDecimalString,
} from "@/lib/i18n";

// 2026-11-21T03:30:00Z is still Nov 20 in New York and already Nov 21 afternoon... in Jerusalem 05:30.
const INSTANT = "2026-11-21T03:30:00Z";

describe("date and time formatting is time-zone aware (spec 16.5)", () => {
  it("shows the same instant differently per business time zone", () => {
    expect(formatTime(INSTANT, { locale: "en-US", timeZone: "America/New_York" })).toBe("10:30 PM");
    expect(formatTime(INSTANT, { locale: "en-US", timeZone: "Asia/Jerusalem" })).toBe("5:30 AM");
    expect(formatTime(INSTANT, { locale: "en-US", timeZone: "America/Los_Angeles" })).toBe("7:30 PM");
  });

  it("can land on a different calendar day depending on the zone", () => {
    expect(formatDate(INSTANT, { locale: "en-US", timeZone: "America/New_York" })).toBe("Nov 20, 2026");
    expect(formatDate(INSTANT, { locale: "en-US", timeZone: "Asia/Jerusalem" })).toBe("Nov 21, 2026");
  });

  it("follows daylight saving for the zone (same UTC hour, different offset)", () => {
    const winter = formatTime("2026-01-15T17:00:00Z", { locale: "en-US", timeZone: "America/New_York" });
    const summer = formatTime("2026-07-15T17:00:00Z", { locale: "en-US", timeZone: "America/New_York" });
    expect(winter).toBe("12:00 PM");
    expect(summer).toBe("1:00 PM");
  });

  it("localizes the output and can append the zone name", () => {
    const es = formatDateTime(INSTANT, { locale: "es-US", timeZone: "America/New_York" });
    expect(es).toContain("nov");
    expect(formatDateTimeWithZone(INSTANT, { locale: "en-US", timeZone: "America/New_York" })).toContain("EST");
    expect(formatDate(INSTANT, { locale: "he-IL", timeZone: "Asia/Jerusalem" })).toMatch(/[֐-׿]/);
  });

  it("accepts Date objects and rejects invalid input loudly", () => {
    expect(formatTime(new Date(INSTANT), { locale: "en-US", timeZone: "UTC" })).toBe("3:30 AM");
    expect(() => formatDate("not-a-date", { locale: "en-US", timeZone: "UTC" })).toThrow(RangeError);
    expect(() => formatDate(INSTANT, { locale: "en-US", timeZone: "Bad/Zone" })).toThrow();
  });
});

describe("number and currency formatting", () => {
  it("formats numbers and percents", () => {
    expect(formatNumber(1234567.5, "en-US")).toBe("1,234,567.5");
    expect(formatPercent(0.256, "en-US")).toBe("25.6%");
  });

  it("formats USD from integer cents without float math", () => {
    expect(formatMoneyFromMinorUnits(123456, { locale: "en-US" })).toBe("$1,234.56");
    expect(formatMoneyFromMinorUnits(5, { locale: "en-US" })).toBe("$0.05");
    expect(formatMoneyFromMinorUnits(-5, { locale: "en-US" })).toBe("-$0.05");
    expect(formatMoneyFromMinorUnits(0n, { locale: "en-US" })).toBe("$0.00");
  });

  it("keeps full precision for amounts beyond the float-safe range", () => {
    expect(formatMoneyFromMinorUnits(9007199254740993123n, { locale: "en-US" })).toBe("$90,071,992,547,409,931.23");
  });

  it("rejects fractional or unsafe minor-unit numbers", () => {
    expect(() => formatMoneyFromMinorUnits(10.5, { locale: "en-US" })).toThrow(RangeError);
    expect(() => formatMoneyFromMinorUnits(Number.MAX_SAFE_INTEGER + 2, { locale: "en-US" })).toThrow(RangeError);
  });

  it("renders currency per locale", () => {
    expect(formatMoneyFromMinorUnits(123456, { locale: "he-IL" })).toContain("1,234.56");
    expect(formatMoneyFromMinorUnits(123456, { locale: "he-IL" })).toContain("$");
    expect(formatMoneyFromMinorUnits(123456, { locale: "es-US" })).toBe("$1,234.56");
  });

  it("converts minor units to decimal strings", () => {
    expect(minorUnitsToDecimalString(1234n, 2)).toBe("12.34");
    expect(minorUnitsToDecimalString(-5n, 2)).toBe("-0.05");
    expect(minorUnitsToDecimalString(700n, 0)).toBe("700");
  });
});

describe("phone display", () => {
  it("formats NANP E.164 numbers", () => {
    expect(formatPhone("+12125550123")).toBe("+1 (212) 555-0123");
  });

  it("leaves other countries as E.164 and rejects non-E.164 input", () => {
    expect(formatPhone("+972501234567")).toBe("+972501234567");
    expect(() => formatPhone("212-555-0123")).toThrow(RangeError);
    expect(() => formatPhone("+0123456789")).toThrow(RangeError);
  });

  it("isolates LTR content for use inside RTL text", () => {
    const wrapped = isolateLtr("+1 (212) 555-0123");
    expect(wrapped.startsWith("⁦")).toBe(true);
    expect(wrapped.endsWith("⁩")).toBe(true);
  });
});
