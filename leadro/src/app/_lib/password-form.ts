import { z } from "zod";

/** Fields of the choose-a-password forms. Length policy is enforced by the auth service. */
export const newPasswordFormSchema = z.object({
  token: z.string().min(1).max(500),
  password: z.string().min(1).max(1000),
  confirmPassword: z.string().max(1000),
});

export type NewPasswordFormValues = z.infer<typeof newPasswordFormSchema>;

export function readNewPasswordForm(formData: FormData) {
  return newPasswordFormSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
}
