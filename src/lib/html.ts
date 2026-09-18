/**
 * Escaping text that is about to become HTML.
 *
 * React escapes everything it renders, so almost nothing in this codebase
 * needs this. The exception is the map popup: maplibre takes a string of HTML
 * (`Popup.setHTML`), so the listing's title and city - which a media owner
 * types - are concatenated into markup by hand. That is the one place in VELTO
 * where owner-supplied text becomes HTML without React in the way.
 *
 * It lives here rather than inside the map component for a reason that is not
 * tidiness: vitest runs under node with no jsdom, so nothing importing
 * maplibre-gl can be unit-tested, and a security control that cannot be tested
 * is a security control nobody will notice breaking. See tests/html.test.ts.
 *
 * This is also what makes VELTO unaffected by the maplibre advisory tracked in
 * TODO.md - the sanitizer bypass in the library's own DOM.sanitize() needs
 * attacker-controlled markup to reach it, and by the time a popup string is
 * built here, there is none left.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
