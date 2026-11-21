import { z } from "zod";
import { SUPPORTED_LOCALES, isValidTimeZone } from "@/lib/i18n";
import { pageQuerySchema } from "@/server/core";

export const userIdSchema = z.string().trim().min(1).max(64);

export const listUsersQuerySchema = pageQuerySchema.extend({
  status: z.enum(["INVITED", "ACTIVE", "LOCKED", "DEACTIVATED"]).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** A user may be given (or have cleared) their own locale and time zone; `null` = inherit from the branch/company. */
export const updateUserSchema = z
  .object({
    locale: z.enum(SUPPORTED_LOCALES).nullish(),
    timeZone: z.string().max(64).refine(isValidTimeZone, "Unknown IANA time zone").nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const deactivateUserSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export type DeactivateUserInput = z.infer<typeof deactivateUserSchema>;

/** Length rules live in auth's password policy (one place); this only bounds the input size. */
export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(1000), newPassword: z.string().min(1).max(1000) })
  .strict();
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
