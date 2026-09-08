import "server-only";

import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth";
import { canDeleteAccount } from "@/server/account";
import { formatDate } from "@/lib/dates";
import { t } from "@/lib/labels";
import type { AccountData } from "@/components/account/AccountForms";

/**
 * What the account page needs, for whichever role is asking. Advertisers and
 * media owners get the same account surface; only the surrounding shell and
 * navigation differ, so this is shared rather than duplicated per route.
 */
export async function loadAccountPage(): Promise<{
  data: AccountData;
  deletionBlocked: string | null;
  role: string;
}> {
  const user = await requireUser();
  const company = user.companyId
    ? await prisma.company.findUnique({
        where: { id: user.companyId },
        select: { name: true, contactEmail: true, contactPhone: true, website: true, businessId: true },
      })
    : null;

  const check = await canDeleteAccount(user.id);

  return {
    role: user.role,
    data: {
      name: user.name,
      email: user.email,
      phone: user.phone ?? null,
      roleLabel: t(`role.${user.role}`),
      company,
    },
    // Told up front rather than after the confirmation word is typed: being
    // refused at the last step of an irreversible action reads as a bug.
    deletionBlocked: check.ok
      ? null
      : `יש ${check.count} הזמנות מאושרות שטרם הסתיימו (האחרונה עד ${formatDate(check.until)}). יש לבטל אותן או להמתין לסיומן לפני מחיקת החשבון.`,
  };
}
