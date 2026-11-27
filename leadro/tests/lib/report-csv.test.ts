import { describe, expect, it } from "vitest";
import {
  CSV_BOM,
  canonicalJson,
  csvField,
  filtersHash,
  formatInstantInZone,
  formatMinorUnits,
  startsLikeFormula,
  toCsvDocument,
} from "@/lib/report-csv";

describe("report CSV helpers", () => {
  it.each(["=SUM(A1)", "+1", "-2+3", "@cmd", "\tx", "\rx"])("neutralizes a text cell starting like a formula: %j", (value) => {
    expect(startsLikeFormula(value)).toBe(true);
    expect(csvField(value, true).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
  });

  it("leaves ordinary text and server-formatted numbers alone, and quotes per RFC 4180", () => {
    expect(csvField("Acme Plumbing", true)).toBe("Acme Plumbing");
    expect(csvField("-12.50", false)).toBe("-12.50");
    expect(csvField('Say "hi", then go', true)).toBe('"Say ""hi"", then go"');
    expect(csvField("line\nbreak", true)).toBe('"line\nbreak"');
    expect(csvField(" padded", true)).toBe('" padded"');
    expect(csvField("=1,2", true)).toBe(`"'=1,2"`);
  });

  it("builds a document with a BOM, a header and CRLF lines", () => {
    expect(toCsvDocument(["a", "b"], [["1", "2"], ["3", ""]])).toBe(`${CSV_BOM}a,b\r\n1,2\r\n3,\r\n`);
  });

  it("formats minor units as exact decimal strings per currency", () => {
    expect(formatMinorUnits(12345n, "USD")).toBe("123.45");
    expect(formatMinorUnits(5n, "USD")).toBe("0.05");
    expect(formatMinorUnits(-5n, "USD")).toBe("-0.05");
    expect(formatMinorUnits(0n, "EUR")).toBe("0.00");
    expect(formatMinorUnits(500n, "JPY")).toBe("500");
    expect(formatMinorUnits(1234n, "KWD")).toBe("1.234");
    expect(formatMinorUnits(999_999_999_999_999n, "USD")).toBe("9999999999999.99");
  });

  it("formats instants in the tenant zone with the offset in force at that instant", () => {
    expect(formatInstantInZone(new Date("2026-03-10T15:00:00.999Z"), "America/New_York")).toBe("2026-03-10T11:00:00-04:00");
    expect(formatInstantInZone(new Date("2026-01-10T15:00:00Z"), "America/New_York")).toBe("2026-01-10T10:00:00-05:00");
    expect(formatInstantInZone(new Date("2026-01-10T15:00:00Z"), "Asia/Jerusalem")).toBe("2026-01-10T17:00:00+02:00");
    expect(formatInstantInZone(new Date("2026-01-10T15:00:00Z"), "Asia/Kolkata")).toBe("2026-01-10T20:30:00+05:30");
    expect(formatInstantInZone(new Date("2026-01-10T15:00:00Z"), "UTC")).toBe("2026-01-10T15:00:00+00:00");
  });

  it("hashes filters independently of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(filtersHash({ status: ["A"], dateFrom: "x" })).toBe(filtersHash({ dateFrom: "x", status: ["A"] }));
    expect(filtersHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
