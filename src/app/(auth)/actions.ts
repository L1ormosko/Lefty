"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/server/db";
import { createPasswordResetToken, createSession, destroySession, hashPassword, login, resetPassword } from "@/server/auth";
import { loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema, fieldErrors } from "@/lib/validation";
import { toUserMessage } from "@/server/errors";
import { t } from "@/lib/labels";
import { rateLimit } from "@/server/rate-limit";
import { sendEmail } from "@/server/email";

export type FormState =
  | { error?: string; fields?: Record<string, string>; success?: string }
  | undefined;

async function clientKey(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function landingFor(role: string) {
  if (role === "MEDIA_OWNER") return "/owner";
  if (role === "ADMIN") return "/admin";
  return "/dashboard";
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fields: fieldErrors(parsed.error) };

  let target: string;
  try {
    const user = await login(parsed.data.email, parsed.data.password, await clientKey());
    target = (formData.get("next") as string) || landingFor(user.role);
  } catch (err) {
    return { error: t(toUserMessage(err)) };
  }
  redirect(target);
}

export async function registerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fields: fieldErrors(parsed.error) };
  const { name, email, password, phone, role, companyName, businessId } = parsed.data;

  const limited = rateLimit(`register:${await clientKey()}`, 10, 60 * 60_000);
  if (!limited.ok) return { error: t("auth.tooManyAttempts") };

  let target: string;
  try {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return { fields: { email: t("auth.emailTaken") } };

    const company = companyName
      ? await prisma.company.create({
          data: {
            name: companyName,
            type: role === "MEDIA_OWNER" ? "MEDIA_OWNER" : "ADVERTISER",
            contactEmail: email,
            contactPhone: phone || null,
            businessId: businessId || null,
          },
        })
      : null;

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await hashPassword(password),
        phone: phone || null,
        role,
        companyId: company?.id ?? null,
        // The registration form requires the checkbox, so this is always "now".
        termsAcceptedAt: new Date(),
      },
    });
    await createSession(user.id);
    target = landingFor(user.role);
  } catch (err) {
    return { error: toUserMessage(err) };
  }
  redirect(target);
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/");
}

export async function forgotPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = forgotPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fields: fieldErrors(parsed.error) };

  const token = await createPasswordResetToken(parsed.data.email, await clientKey());
  if (token) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
    await sendEmail({
      to: parsed.data.email,
      subject: t("auth.resetPasswordTitle"),
      text: `${appUrl}/reset-password?token=${token}`,
    });
  }
  // Same response whether or not the email exists - no account enumeration.
  return { success: t("auth.forgotPasswordSent") };
}

export async function resetPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = resetPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fields: fieldErrors(parsed.error) };

  try {
    await resetPassword(parsed.data.token, parsed.data.password);
  } catch (err) {
    return { error: t(toUserMessage(err)) };
  }
  return { success: t("auth.resetPasswordSuccess") };
}
