import { t } from "./labels";

/**
 * What each role navigates by.
 *
 * These lists used to carry "התראות" and "פרופיל" as well, in all three of
 * them, and the header carried those two again - so a signed-in dashboard
 * screen offered twelve navigation controls with two of them duplicated.
 * Neither belongs to a section: they belong to whoever is signed in, and they
 * now live in one account menu in the header (components/AccountMenu).
 *
 * What is left is the work. The rule for adding to these lists: a link earns
 * a place here if it is somewhere this role goes to do their job, not merely
 * somewhere they can go.
 */

export const advertiserNav = (counts: { requests?: number } = {}) => [
  { href: "/dashboard", label: t("dash.overview") },
  // "בריף" is in the site header too, where a visitor who has not signed in
  // can reach it. One of the two had to go and it was this one: the header's
  // is there on every page, this one only on four.
  { href: "/dashboard/requests", label: t("dash.myRequests"), badge: counts.requests },
  { href: "/dashboard/bookings", label: t("dash.myBookings") },
  { href: "/dashboard/saved", label: t("dash.savedAssets") },
];

export const ownerNav = (counts: { inquiries?: number; bookings?: number } = {}) => [
  { href: "/owner", label: t("dash.overview") },
  { href: "/owner/assets", label: t("dash.myAssets") },
  { href: "/owner/inquiries", label: t("dash.requests"), badge: counts.inquiries },
  { href: "/owner/bookings", label: t("dash.bookings"), badge: counts.bookings },
];

/**
 * The admin's is longer because the job is, but it is not one flat pile.
 *
 * The first four are queues - places where something is waiting for a person.
 * The last two are reference: looked at when a question comes up, not worked
 * through. A rule between them says which kind you are about to open.
 */
export const adminNav = (counts: { access?: number } = {}) => [
  { href: "/admin", label: t("dash.overview") },
  { href: "/admin/assets", label: t("admin.assets") },
  // Badged, because this is the queue where someone is waiting to give VELTO
  // money. A request that sits unseen is the paywall failing in the expensive
  // direction.
  { href: "/admin/access", label: t("admin.accessRequests"), badge: counts.access },
  { href: "/admin/inquiries", label: t("dash.requests") },
  { href: "/admin/bookings", label: t("dash.bookings") },
  { href: "/admin/users", label: t("admin.users"), divider: true },
  { href: "/admin/audit", label: t("audit.title") },
];
