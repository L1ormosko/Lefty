import type { Metadata } from "next";
import { citiesWithInventory } from "@/server/assets";
import { t } from "@/lib/labels";
import { Card, LinkButton, Num } from "@/components/ui";
import { AvailabilityBadge, VerificationBadge } from "@/components/badges";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "VELTO — שטחי פרסום חוץ בישראל",
  description: t("app.tagline"),
};

export const dynamic = "force-dynamic";

function StepList({
  title,
  steps,
}: {
  title: string;
  steps: { title: string; body: string }[];
}) {
  return (
    <Card className="p-6">
      <h2 className="font-semibold text-ink-900 mb-4">{title}</h2>
      <ol className="space-y-4">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span className="shrink-0 size-7 rounded-full bg-ink-900 text-white text-sm font-semibold flex items-center justify-center">
              <Num>{i + 1}</Num>
            </span>
            <div>
              <p className="font-medium text-ink-900">{step.title}</p>
              <p className="text-sm text-ink-600 mt-0.5">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default async function LandingPage() {
  const cities = await citiesWithInventory();

  return (
    <>
      <main className="flex-1">
      {/* Hero */}
      <section className="border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-16 sm:py-24 text-center">
          <h1 className="text-3xl sm:text-5xl font-semibold text-ink-900 tracking-tight text-balance">
            {t("landing.headline")}
          </h1>
          <p className="mt-4 text-base sm:text-lg text-ink-600 max-w-2xl mx-auto text-balance">
            {t("landing.sub")}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/explore" size="lg">
              {t("landing.ctaExplore")}
            </LinkButton>
            <LinkButton href="/register?role=MEDIA_OWNER" variant="secondary" size="lg">
              {t("landing.ctaOwner")}
            </LinkButton>
          </div>
          {cities.length > 0 && (
            <p className="mt-6 text-sm text-ink-500">
              {t("landing.inventoryNote", { count: cities.length })}
            </p>
          )}
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-5xl px-4 py-14">
        <div className="grid md:grid-cols-2 gap-6">
          <StepList
            title={t("landing.advertiserTitle")}
            steps={[
              { title: t("landing.advertiserStep1Title"), body: t("landing.advertiserStep1Body") },
              { title: t("landing.advertiserStep2Title"), body: t("landing.advertiserStep2Body") },
              { title: t("landing.advertiserStep3Title"), body: t("landing.advertiserStep3Body") },
            ]}
          />
          <StepList
            title={t("landing.ownerTitle")}
            steps={[
              { title: t("landing.ownerStep1Title"), body: t("landing.ownerStep1Body") },
              { title: t("landing.ownerStep2Title"), body: t("landing.ownerStep2Body") },
              { title: t("landing.ownerStep3Title"), body: t("landing.ownerStep3Body") },
            ]}
          />
        </div>
      </section>

      {/* Trust */}
      <section className="border-y border-ink-200 bg-ink-50">
        <div className="mx-auto max-w-3xl px-4 py-14 text-center">
          <h2 className="font-semibold text-xl text-ink-900">{t("landing.trustTitle")}</h2>
          <p className="mt-3 text-ink-600 max-w-xl mx-auto">{t("landing.trustBody")}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <VerificationBadge status="VERIFIED" />
            <VerificationBadge status="PENDING" />
            <AvailabilityBadge state="AVAILABLE" />
            <AvailabilityBadge state="PARTIAL" />
            <AvailabilityBadge state="OCCUPIED" />
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="mx-auto max-w-3xl px-4 py-14 text-center">
        <h2 className="font-semibold text-xl text-ink-900">{t("landing.footerCta")}</h2>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <LinkButton href="/explore" size="lg">
            {t("landing.ctaExplore")}
          </LinkButton>
          <LinkButton href="/register?role=MEDIA_OWNER" variant="secondary" size="lg">
            {t("landing.ctaOwner")}
          </LinkButton>
        </div>
        <p className="mt-4 text-sm text-ink-500">
          {t("landing.footerLogin")}{" "}
          <a href="/login" className="text-brand-600 hover:underline">
            {t("auth.login")}
          </a>
        </p>
      </section>
      </main>
      <SiteFooter />
    </>
  );
}
