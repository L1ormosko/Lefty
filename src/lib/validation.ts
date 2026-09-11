/** Input schemas. Everything crossing the network boundary is parsed here. */
import { z } from "zod";
import { ASSET_TYPES, ILLUMINATIONS, LOCATION_TAGS, PERMIT_STATUSES, ISRAEL_BOUNDS } from "./constants";

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "תאריך לא תקין");

export const emailSchema = z.string().trim().toLowerCase().email("כתובת דוא״ל לא תקינה");
export const passwordSchema = z.string().min(8, "auth.passwordRule").max(200);
const phoneSchema = z
  .string()
  .trim()
  .regex(/^[0-9+\-() ]{7,20}$/, "מספר טלפון לא תקין");

export const registerSchema = z.object({
  name: z.string().trim().min(2, "יש להזין שם מלא").max(120),
  email: emailSchema,
  password: passwordSchema,
  phone: phoneSchema.optional().or(z.literal("")),
  role: z.enum(["ADVERTISER", "MEDIA_OWNER"]),
  companyName: z.string().trim().min(2).max(160).optional().or(z.literal("")),
  businessId: z.string().trim().max(20).optional().or(z.literal("")),
  acceptedTerms: z.literal("on", { message: "legal.acceptRequired" }),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "common.required"),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

/**
 * Editing your own profile. Deliberately no email and no role: changing the
 * login identity needs a verification step this product does not have yet, and
 * role is not the user's to grant themselves.
 */
export const profileSchema = z.object({
  name: z.string().trim().min(2, "יש להזין שם מלא").max(120),
  phone: phoneSchema.optional().or(z.literal("")),
  companyName: z.string().trim().min(2).max(160).optional().or(z.literal("")),
  companyEmail: emailSchema.optional().or(z.literal("")),
  companyPhone: phoneSchema.optional().or(z.literal("")),
  companyWebsite: z.string().trim().url("כתובת אתר לא תקינה").max(200).optional().or(z.literal("")),
  businessId: z.string().trim().max(20).optional().or(z.literal("")),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "common.required"),
  password: passwordSchema,
});

/**
 * Closing an account. The current password proves it is really the account
 * holder at the keyboard, and the typed word makes an irreversible action
 * deliberate rather than a mis-tap.
 */
export const deleteAccountSchema = z.object({
  currentPassword: z.string().min(1, "common.required"),
  confirm: z.literal("מחיקה", { message: "יש להקליד את המילה מחיקה לאישור." }),
});

export const assetBasicSchema = z.object({
  title: z.string().trim().min(3, "יש להזין שם לשטח").max(160),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  assetType: z.enum(ASSET_TYPES as [string, ...string[]]),
});

export const assetLocationSchema = z.object({
  address: z.string().trim().min(3, "יש להזין כתובת").max(200),
  city: z.string().trim().min(2, "יש להזין עיר").max(80),
  region: z.string().trim().max(80).optional().or(z.literal("")),
  latitude: z.coerce
    .number()
    .min(ISRAEL_BOUNDS.minLat, "הנקודה נמצאת מחוץ לגבולות ישראל")
    .max(ISRAEL_BOUNDS.maxLat, "הנקודה נמצאת מחוץ לגבולות ישראל"),
  longitude: z.coerce
    .number()
    .min(ISRAEL_BOUNDS.minLng, "הנקודה נמצאת מחוץ לגבולות ישראל")
    .max(ISRAEL_BOUNDS.maxLng, "הנקודה נמצאת מחוץ לגבולות ישראל"),
});

const optionalPositiveInt = z.union([z.coerce.number().int().positive(), z.literal("")]).optional();

export const assetSpecsSchema = z.object({
  widthCm: optionalPositiveInt,
  heightCm: optionalPositiveInt,
  orientation: z.string().trim().max(40).optional().or(z.literal("")),
  sides: z.coerce.number().int().min(1).max(8).default(1),
  illumination: z.enum(ILLUMINATIONS as [string, ...string[]]).default("UNKNOWN"),
  isDigital: z.coerce.boolean().default(false),
  permitStatus: z.enum(PERMIT_STATUSES as [string, ...string[]]).default("UNKNOWN"),
  // Owner-declared surroundings. Unknown values are rejected rather than
  // dropped: a tag that is not in our vocabulary means the form and the schema
  // have drifted apart, which is worth failing on.
  locationTags: z.array(z.enum(LOCATION_TAGS as [string, ...string[]])).max(11).default([]),
});

export const assetPricingSchema = z.object({
  priceWeekly: optionalPositiveInt,
  priceMonthly: optionalPositiveInt,
  minimumBookingDays: z.coerce.number().int().min(1).max(365).default(7),
  productionIncluded: z.coerce.boolean().default(false),
  installationIncluded: z.coerce.boolean().default(false),
  removalIncluded: z.coerce.boolean().default(false),
  instantBookable: z.coerce.boolean().default(false),
});

export const availabilityPeriodSchema = z
  .object({
    startDate: isoDateString,
    endDate: isoDateString,
    note: z.string().trim().max(200).optional().or(z.literal("")),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "request.dateOrderError",
    path: ["endDate"],
  });

export const inquirySchema = z
  .object({
    assetId: z.string().min(1),
    intent: z.enum(["AVAILABILITY", "QUOTE", "BOOKING"]).default("AVAILABILITY"),
    startDate: isoDateString,
    endDate: isoDateString,
    campaignName: z.string().trim().min(2, "יש להזין שם קמפיין").max(160),
    budget: optionalPositiveInt,
    message: z.string().trim().max(2000).optional().or(z.literal("")),
    contactName: z.string().trim().min(2, "יש להזין שם איש קשר").max(120),
    contactEmail: emailSchema,
    contactPhone: phoneSchema.optional().or(z.literal("")),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "request.dateOrderError",
    path: ["endDate"],
  });

/** A message on an inquiry, from either side of the conversation. */
export const inquiryMessageSchema = z.object({
  inquiryId: z.string().min(1),
  body: z.string().trim().min(2, "יש להזין הודעה").max(2000),
});

export const bookingDecisionSchema = z.object({
  bookingId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  ownerNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const mapQuerySchema = z.object({
  minLat: z.coerce.number().min(-90).max(90).optional(),
  maxLat: z.coerce.number().min(-90).max(90).optional(),
  minLng: z.coerce.number().min(-180).max(180).optional(),
  maxLng: z.coerce.number().min(-180).max(180).optional(),
  city: z.string().trim().max(80).optional(),
  q: z.string().trim().max(120).optional(),
  types: z.string().trim().max(300).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional(),
  digitalOnly: z.enum(["1", "0"]).optional(),
  verifiedOnly: z.enum(["1", "0"]).optional(),
  availability: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});

export type MapQuery = z.infer<typeof mapQuerySchema>;

/**
 * The brief form's query string.
 *
 * Everything is optional and nothing has a default beyond "not stated". A
 * brief that invents a city or a budget the advertiser never typed would go on
 * to filter real inventory out of their shortlist.
 */
export const briefQuerySchema = z.object({
  text: z.string().trim().max(1000).optional(),
  cities: z.string().trim().max(300).optional(),
  types: z.string().trim().max(300).optional(),
  tags: z.string().trim().max(300).optional(),
  startDate: isoDateString.optional().or(z.literal("")),
  endDate: isoDateString.optional().or(z.literal("")),
  budget: z.union([z.coerce.number().int().positive(), z.literal("")]).optional(),
  digitalOnly: z.enum(["1", "0"]).optional(),
  verifiedOnly: z.enum(["1", "0"]).optional(),
});

export type BriefQuery = z.infer<typeof briefQuerySchema>;

/** Flatten a ZodError into { field: message } for form rendering. */
export function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
