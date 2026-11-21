import { describe, expect, it } from "vitest";
import {
  buildLocaleChain,
  resolveCustomerCommunicationLocale,
  resolveTimeZone,
  resolveUiLocale,
} from "@/lib/i18n";

describe("locale resolution (spec 16.2)", () => {
  it("prefers user over branch over company over en-US", () => {
    expect(buildLocaleChain({ user: "he-IL", branch: "es-US", company: "en-US" })).toEqual(["he-IL", "es-US", "en-US"]);
    expect(resolveUiLocale({ user: null, branch: "es-US", company: "he-IL" })).toBe("es-US");
    expect(resolveUiLocale({ user: null, branch: null, company: "he-IL" })).toBe("he-IL");
    expect(resolveUiLocale({})).toBe("en-US");
  });

  it("skips unsupported values instead of failing", () => {
    expect(buildLocaleChain({ user: "fr-FR", company: "es-US" })).toEqual(["es-US", "en-US"]);
  });

  it("uses the customer's preference for customer communication, not the staff user's", () => {
    expect(resolveCustomerCommunicationLocale({ customer: "es-US", branch: "he-IL", company: "en-US" })).toBe("es-US");
    expect(resolveCustomerCommunicationLocale({ customer: null, branch: "he-IL", company: "en-US" })).toBe("he-IL");
  });

  it("resolves the time zone user → branch → company and skips invalid zones", () => {
    expect(resolveTimeZone({ user: "Asia/Jerusalem", branch: "America/Chicago", company: "America/New_York" })).toBe("Asia/Jerusalem");
    expect(resolveTimeZone({ branch: "America/Chicago", company: "America/New_York" })).toBe("America/Chicago");
    expect(resolveTimeZone({ user: "Not/AZone", company: "America/New_York" })).toBe("America/New_York");
  });
});
