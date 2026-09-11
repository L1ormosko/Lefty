import { t } from "./labels";

export const advertiserNav = (counts: { requests?: number } = {}) => [
  { href: "/dashboard", label: t("dash.overview") },
  { href: "/brief", label: t("nav.brief") },
  { href: "/dashboard/requests", label: t("dash.myRequests"), badge: counts.requests },
  { href: "/dashboard/bookings", label: t("dash.myBookings") },
  { href: "/dashboard/saved", label: t("dash.savedAssets") },
  { href: "/dashboard/notifications", label: t("nav.notifications") },
  { href: "/dashboard/profile", label: t("dash.profile") },
];

export const ownerNav = (counts: { inquiries?: number; bookings?: number } = {}) => [
  { href: "/owner", label: t("dash.overview") },
  { href: "/owner/assets", label: t("dash.myAssets") },
  { href: "/owner/inquiries", label: t("dash.requests"), badge: counts.inquiries },
  { href: "/owner/bookings", label: t("dash.bookings"), badge: counts.bookings },
  { href: "/owner/notifications", label: t("nav.notifications") },
  { href: "/owner/profile", label: t("dash.profile") },
];

export const adminNav = () => [
  { href: "/admin", label: t("dash.overview") },
  { href: "/admin/assets", label: t("admin.assets") },
  { href: "/admin/users", label: t("admin.users") },
  { href: "/admin/inquiries", label: t("dash.requests") },
  { href: "/admin/bookings", label: t("dash.bookings") },
];
