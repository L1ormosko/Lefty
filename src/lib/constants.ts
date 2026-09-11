/**
 * Central definition of every domain enum used by the UI.
 * Nothing in the application may hardcode an asset type or a status label:
 * everything reads from here (values mirror the Prisma enums).
 */
import type {
  AssetType,
  AssetStatus,
  Illumination,
  LocationTag,
  VerificationStatus,
  PermitStatus,
  InquiryStatus,
  InquiryIntent,
  BookingStatus,
  Role,
} from "@prisma/client";

export const ASSET_TYPES: AssetType[] = [
  "BILLBOARD",
  "DIGITAL_BILLBOARD",
  "WALL",
  "TOTEM",
  "BUS_STOP",
  "STREET_FURNITURE",
  "BANNER",
  "OTHER",
];

/**
 * Owner-declared location context. Not an audience measurement, and the UI
 * must never present it as one - see the enum's comment in schema.prisma.
 */
export const LOCATION_TAGS: LocationTag[] = [
  "CITY_CENTER",
  "MALL",
  "HIGHWAY",
  "MAIN_ROAD",
  "INDUSTRIAL",
  "RESIDENTIAL",
  "TRANSIT_HUB",
  "EDUCATION",
  "HOSPITAL",
  "STADIUM",
  "BEACH",
];

export const ILLUMINATIONS: Illumination[] = ["NONE", "FRONTLIT", "BACKLIT", "UNKNOWN"];
export const ASSET_STATUSES: AssetStatus[] = ["DRAFT", "ACTIVE", "INACTIVE"];
export const VERIFICATION_STATUSES: VerificationStatus[] = ["PENDING", "VERIFIED", "REJECTED"];
export const PERMIT_STATUSES: PermitStatus[] = ["UNKNOWN", "PERMITTED", "NOT_PERMITTED"];
export const INQUIRY_STATUSES: InquiryStatus[] = ["PENDING", "RESPONDED", "CLOSED"];
export const INQUIRY_INTENTS: InquiryIntent[] = ["AVAILABILITY", "QUOTE", "BOOKING"];
export const BOOKING_STATUSES: BookingStatus[] = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "COMPLETED",
];
export const ROLES: Role[] = ["ADVERTISER", "MEDIA_OWNER", "ADMIN"];

/**
 * Availability of an asset for a given date window. Derived at query time -
 * never stored on the asset, because it depends on the dates being asked about.
 */
export const AVAILABILITY_STATES = [
  "AVAILABLE",
  "PARTIAL",
  "OCCUPIED",
  "INACTIVE",
  "PENDING_VERIFICATION",
] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/** Marker / badge colours. Colour is never the only signal - see labels.ts. */
export const AVAILABILITY_COLORS: Record<AvailabilityState, string> = {
  AVAILABLE: "#128a51",
  PARTIAL: "#a86a09",
  OCCUPIED: "#b42318",
  INACTIVE: "#67758c",
  PENDING_VERIFICATION: "#525e73",
};

/** Israel bounding box, used to constrain the map and validate coordinates. */
export const ISRAEL_BOUNDS = {
  minLat: 29.35,
  maxLat: 33.42,
  minLng: 34.2,
  maxLng: 35.95,
} as const;

/** Where the map opens: the first commercial market. */
export const DEFAULT_MAP_CENTER = { lng: 34.7913, lat: 31.2518, zoom: 12.2 };
export const ISRAEL_VIEW = { lng: 35.0, lat: 31.6, zoom: 7 };

export const CURRENCY = "₪";
