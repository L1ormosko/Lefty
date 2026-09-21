"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/server/db";
import { createPasswordResetToken, createSession, destroySession, hashPassword, login, resetPassword } from "@/server/auth";
import { loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema, fieldErrors } from "@/lib/validation";
import { toUserMessage } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { trialEnd } from "@/lib/subscription";
import { t } from "@/lib/labels";
import { rateLimit } from "@/server/rate-limit";
import { emailConfigured, sendEmail } from "@/server/email";

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
        // `company: { connect }` rather than the `companyId` scalar. Prisma has
        // two create shapes - all-scalars or all-relations - and the nested
        // subscription below forces the relation form, which rejects a raw
        // foreign key with "Unknown argument companyId".
        company: company ? { connect: { id: company.id } } : undefined,
        // The registration form requires the checkbox, so this is always "now".
        termsAcceptedAt: new Date(),
        // The free trial is created with the account, in the same statement.
        // Granting it afterwards would leave a window in which a signup that
        // half-failed produced a user with no access at all, and the person
        // most likely to hit that window is the one who just gave us money's
        // worth of attention.
        subscription: { create: { trialEndsAt: trialEnd() } },
      },
    });
    await recordAudit({
      actorId: user.id,
      action: "USER_REGISTERED",
      targetType: "User",
      targetId: user.id,
      summary: `${user.email} · ${user.role}`,
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

  /*
   * The provider is checked before the account is, and on purpose.
   *
   * Without RESEND_API_KEY, sendEmail is a no-op - so the old code told
   * everyone "we have sent you a link" and sent nothing, which for anyone who
   * had actually forgotten their password was a dead end with no sign that it
   * was one. Saying so costs nothing in enumeration terms: this is a fact
   * about the platform, identical for an address that exists and one that
   * does not, and no token is minted either way.
   */
  if (!emailConfigured()) {
    return { error: t("auth.forgotPasswordUnavailable") };
  }

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
