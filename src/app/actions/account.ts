"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { createSession, destroySession, hashPassword, requireUser, verifyPassword } from "@/server/auth";
import { anonymizeUser } from "@/server/account";
import { toUserMessage } from "@/server/errors";
import { changePasswordSchema, deleteAccountSchema, fieldErrors, profileSchema } from "@/lib/validation";
import { rateLimit } from "@/server/rate-limit";
import type { ActionState } from "./inquiries";

/**
 * The user's own account. Every action reads the id from the session and never
 * from the form, so there is no object to tamper with: a request can only ever
 * act on the account it is authenticated as.
 */

export async function updateProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const parsed = profileSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
    const d = parsed.data;

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { name: d.name, phone: d.phone || null },
      });

      if (!d.companyName) return;
      const companyData = {
        name: d.companyName,
        contactEmail: d.companyEmail || user.email,
        contactPhone: d.companyPhone || null,
        website: d.companyWebsite || null,
        businessId: d.businessId || null,
      };

      if (user.companyId) {
        await tx.company.update({ where: { id: user.companyId }, data: companyData });
      } else {
        // Someone who registered without a company name filling it in later.
        const company = await tx.company.create({
          data: {
            ...companyData,
            type: user.role === "MEDIA_OWNER" ? "MEDIA_OWNER" : "ADVERTISER",
          },
        });
        await tx.user.update({ where: { id: user.id }, data: { companyId: company.id } });
      }
    });

    revalidatePath("/dashboard/profile");
    revalidatePath("/owner/profile");
    return { ok: true, message: "הפרטים נשמרו." };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function changePasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const parsed = changePasswordSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };

    // Knowing the session cookie is not the same as knowing the password; an
    // unattended logged-in browser must not be enough to take over the account.
    if (!rateLimit(`password:${user.id}`, 5, 15 * 60_000).ok) {
      return { ok: false, error: "יותר מדי ניסיונות. נסו שוב מאוחר יותר." };
    }
    const record = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!(await verifyPassword(parsed.data.currentPassword, record?.passwordHash ?? null))) {
      return { ok: false, fields: { currentPassword: "הסיסמה הנוכחית שגויה." } };
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(parsed.data.password) },
      }),
      // A credential change ends every other session, the same rule the reset
      // flow follows. The current one is re-created below so the user is not
      // logged out of the tab they are standing in.
      prisma.session.deleteMany({ where: { userId: user.id } }),
    ]);
    await createSession(user.id);

    return { ok: true, message: "הסיסמה עודכנה. כל ההתחברויות האחרות נותקו." };
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }
}

export async function deleteAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const parsed = deleteAccountSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };

    if (!rateLimit(`delete:${user.id}`, 5, 15 * 60_000).ok) {
      return { ok: false, error: "יותר מדי ניסיונות. נסו שוב מאוחר יותר." };
    }
    const record = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!(await verifyPassword(parsed.data.currentPassword, record?.passwordHash ?? null))) {
      return { ok: false, fields: { currentPassword: "הסיסמה שגויה." } };
    }

    await anonymizeUser(user.id);
  } catch (err) {
    return { ok: false, error: toUserMessage(err) };
  }

  // anonymizeUser already deleted the session rows; clear the cookie too so the
  // browser is not left holding a token for an account that no longer exists.
  await destroySession();
  redirect("/login?deleted=1");
}
