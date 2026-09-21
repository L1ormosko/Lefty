import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { viewerAccess } from "@/server/subscription";
import { openRequestFor } from "@/server/access-requests";
import { t } from "@/lib/labels";
import { COMMITMENT_MONTHS } from "@/lib/subscription";
import { formatDate } from "@/lib/dates";
import { Alert, Card, PageSection } from "@/components/ui";
import { RequestAccessForm } from "@/components/access/RequestAccessForm";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata: Metadata = { title: "גישה לחשבון | VELTO" };
export const dynamic = "force-dynamic";

/**
 * Where the paywall sends a signed-in customer.
 *
 * Before this page existed the paywall was a description with no door: the
 * lapsed copy said "for renewal - contact us" and named nobody, and every
 * other button on the screen pointed at /register, which the reader had
 * already done. This is the door.
 *
 * It is not a checkout. VELTO issues no invoices and moves no money - an
 * Israeli tax invoice has to come out of approved bookkeeping software - so
 * what this does is put the request in front of a human and say so plainly.
 * Promising a card form that does not exist would be worse than the dead end
 * it replaces.
 */
export default async function AccessPage() {
  const user = await getCurrentUser();
  // Signed out, this page has nothing to say: the pitch and the trial live on
  // /register, which is where an account actually starts.
  if (!user) redirect("/register");

  const [access, pending, subscription] = await Promise.all([
    viewerAccess(user),
    openRequestFor(user.id),
    prisma.subscription.findUnique({
      where: { userId: user.id },
      select: { paidThrough: true },
    }),
  ]);

  const stateLine = access.admin
    ? t("access.adminNote")
    : access.state === "trial"
      ? t("access.stateTrial", { days: `⁨${access.trialDaysLeft ?? 0}⁩` })
      : access.state === "paid"
        ? t("access.statePaid", {
            date: `⁨${subscription?.paidThrough ? formatDate(subscription.paidThrough) : "—"}⁩`,
          })
        : access.state === "lapsed"
          ? t("access.stateLapsed")
          : t("access.stateNone");

  return (
    <>
      <main className="mx-auto w-full max-w-2xl px-4 py-8 flex-1">
        <h1 className="text-xl font-semibold text-ink-900">{t("access.pageTitle")}</h1>

        <Card className="mt-4 p-4">
          <p className="text-xs text-ink-500">{t("access.stateTitle")}</p>
          <p className="mt-1 text-ink-900">{stateLine}</p>
        </Card>

        {/* Someone who already has access is told so rather than shown a form
            that would be refused on submit. */}
        {access.full ? (
          <Alert kind="success">{t("access.alreadyFull")}</Alert>
        ) : pending ? (
          <PageSection title={t("access.formTitle")} className="mt-6">
            <Alert kind="info">{t("access.pending")}</Alert>
            <p className="mt-2 text-sm text-ink-600">
              {t("access.pendingSince", { date: `⁨${formatDate(pending.createdAt)}⁩` })}
            </p>
            <p className="mt-1 text-sm text-ink-600">{t("access.pendingNote")}</p>
          </PageSection>
        ) : (
          <>
            <PageSection title={t("access.whatYouGet")} className="mt-6">
              <ul className="space-y-1.5 text-sm text-ink-700">
                <li>{t("access.benefit1")}</li>
                <li>{t("access.benefit2")}</li>
                <li>{t("access.benefit3")}</li>
                <li>{t("access.benefit4")}</li>
              </ul>
              <p className="mt-3 text-sm text-ink-600">
                {t("access.trialCtaNote", { months: `⁨${COMMITMENT_MONTHS}⁩` })}
              </p>
            </PageSection>

            <PageSection title={t("access.formTitle")} className="mt-6">
              <RequestAccessForm />
            </PageSection>
          </>
        )}

        <p className="mt-8 text-sm">
          <Link href="/explore" className="text-brand-600 hover:underline">
            → {t("asset.backToMap")}
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
