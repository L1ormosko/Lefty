import type { Metadata } from "next";
import { realInventorySummary } from "@/server/assets";
import { t } from "@/lib/labels";
import { Card, LinkButton, Num } from "@/components/ui";
import { AvailabilityBadge, VerificationBadge } from "@/components/badges";
import { SiteFooter } from "@/components/SiteFooter";
import { HeroMapMotif } from "@/components/landing/HeroMapMotif";

export const metadata: Metadata = {
  title: "VELTO — שטחי פרסום חוץ בישראל",
  description: t("app.tagline"),
};

export const dynamic = "force-dynamic";

function StepList({ title, steps }: { title: string; steps: { title: string; body: string }[] }) {
  return (
    <Card className="p-6">
      <h3 className="font-semibold text-ink-900 mb-4">{title}</h3>
      <ol className="space-y-4">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span className="shrink-0 size-7 rounded-full bg-brand-50 text-brand-700 border border-brand-200 text-sm font-semibold flex items-center justify-center">
              <Num>{i + 1}</Num>
            </span>
            <div>
              <p className="font-medium text-ink-900">{step.title}</p>
              <p className="text-sm text-ink-600 mt-0.5 leading-relaxed">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0 mt-1 text-brand-600"
      aria-hidden="true"
    >
      <path d="m4 10 4 4 8-8" />
    </svg>
  );
}

export default async function LandingPage() {
  const inventory = await realInventorySummary();

  return (
    <>
      <main className="flex-1">
        {/* Hero. The tint is a single soft brand wash behind the map motif -
            enough to stop the fold reading as a blank white page, light enough
            that no text sits on a gradient. */}
        <section className="relative border-b border-ink-200 bg-white overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_36rem_at_15%_-10%,theme(colors.brand.50),transparent_70%)]"
          />
          <div className="relative mx-auto max-w-[1200px] px-4 py-14 sm:py-20 grid lg:grid-cols-[1.25fr_0.75fr] items-center gap-12 lg:gap-16">
            <div>
              <span className="inline-block text-xs font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded px-2 py-1 mb-4">
                {t("landing.eyebrow")}
              </span>
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold text-ink-900 text-balance">
                {t("landing.headline")}
              </h1>
              <p className="mt-4 text-base sm:text-lg text-ink-600 max-w-xl leading-relaxed">
                {t("landing.sub")}
              </p>
              {/* Full width and stacked on a phone, inline from sm up. Left to
                  wrap, the two Hebrew labels are different lengths and produce
                  two buttons of different widths on two lines, which reads as
                  an accident rather than a choice. */}
              <div className="mt-8 flex flex-col sm:flex-row sm:flex-wrap gap-3">
                <LinkButton href="/explore" size="lg" className="w-full sm:w-auto">
                  {t("landing.ctaExplore")}
                </LinkButton>
                <LinkButton
                  href="/register?role=MEDIA_OWNER"
                  variant="secondary"
                  size="lg"
                  className="w-full sm:w-auto"
                >
                  {t("landing.ctaOwner")}
                </LinkButton>
              </div>

              {/* Only ever counts real, non-demo inventory. */}
              <div className="mt-8 pt-6 border-t border-ink-200">
                {inventory.assets > 0 ? (
                  <>
                    <p className="text-xs text-ink-500 mb-2">{t("landing.coverageTitle")}</p>
                    <p className="text-sm text-ink-800 font-medium">
                      <Num>
                        {t("landing.coverageNote", {
                          assets: inventory.assets,
                          cities: inventory.cities.length,
                        })}
                      </Num>
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {inventory.cities.slice(0, 6).map((c) => (
                        <span
                          key={c.city}
                          className="inline-flex items-center gap-1.5 rounded border border-ink-200 bg-ink-50 px-2 py-1 text-xs text-ink-700"
                        >
                          {c.city}
                          <Num className="text-ink-400">{c.count}</Num>
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-ink-500 leading-relaxed max-w-xl">
                    {t("landing.coverageEmpty")}
                  </p>
                )}
              </div>
            </div>

            {/* Capped, and pushed to the far edge. The motif is 3:4, so at the
                column's full width it forced a hero taller than the copy and
                left the text floating in a narrow lane with empty space under
                it. It is decoration; it should not set the height of the fold. */}
            <div className="lg:pb-8 w-full max-w-[380px] mx-auto lg:mx-0 lg:ms-auto">
              <HeroMapMotif />
            </div>
          </div>
        </section>

        {/* Two sides */}
        <section className="bg-ink-50 border-b border-ink-200">
          <div className="mx-auto max-w-3xl px-4 py-14 text-center">
            <h2 className="text-2xl sm:text-3xl font-semibold text-ink-900">
              {t("landing.sidesTitle")}
            </h2>
            <p className="mt-4 text-ink-600 leading-relaxed">{t("landing.sidesBody")}</p>
          </div>
        </section>

        {/* How it works */}
        <section className="bg-ink-50">
          <div className="mx-auto max-w-5xl px-4 pb-16">
            <h2 className="text-2xl sm:text-3xl font-semibold text-ink-900 text-center mb-8">
              {t("landing.howTitle")}
            </h2>
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
          </div>
        </section>

        {/* What the map shows */}
        <section className="bg-white border-y border-ink-200">
          <div className="mx-auto max-w-5xl px-4 py-16">
            <h2 className="text-2xl sm:text-3xl font-semibold text-ink-900 mb-8">
              {t("landing.mapTitle")}
            </h2>
            <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-4">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <li key={n} className="flex gap-2.5 text-sm text-ink-700 leading-relaxed">
                  <CheckIcon />
                  <span>{t(`landing.mapFeature${n}`)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <LinkButton href="/explore" variant="secondary">
                {t("landing.ctaExplore")}
              </LinkButton>
            </div>
          </div>
        </section>

        {/* Trust - the centrepiece for a product with no track record */}
        <section className="bg-ink-50">
          <div className="mx-auto max-w-5xl px-4 py-16 grid lg:grid-cols-[0.9fr_1.1fr] gap-10 lg:gap-14">
            <div>
              <h2 className="text-2xl sm:text-3xl font-semibold text-ink-900 text-balance">
                {t("landing.trustTitle")}
              </h2>
              <p className="mt-4 text-ink-600 leading-relaxed">{t("landing.trustIntro")}</p>
              <div className="mt-6 flex flex-wrap gap-2">
                <VerificationBadge status="VERIFIED" />
                <VerificationBadge status="PENDING" />
                <AvailabilityBadge state="AVAILABLE" />
                <AvailabilityBadge state="PARTIAL" />
                <AvailabilityBadge state="OCCUPIED" />
              </div>
            </div>
            <Card className="p-6">
              <ul className="space-y-4">
                {[1, 2, 3, 4, 5].map((n) => (
                  <li key={n} className="flex gap-2.5 text-sm text-ink-700 leading-relaxed">
                    <CheckIcon />
                    <span>{t(`landing.trustPoint${n}`)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-6 pt-5 border-t border-ink-200 text-sm font-medium text-ink-900 leading-relaxed">
                {t("landing.trustClosing")}
              </p>
            </Card>
          </div>
        </section>

        {/* Who it is for */}
        <section className="bg-white border-y border-ink-200">
          <div className="mx-auto max-w-5xl px-4 py-12 grid sm:grid-cols-2 gap-6">
            <p className="text-sm text-ink-700 leading-relaxed border-s-2 border-brand-500 ps-4">
              {t("landing.audienceAdvertiser")}
            </p>
            <p className="text-sm text-ink-700 leading-relaxed border-s-2 border-ink-300 ps-4">
              {t("landing.audienceOwner")}
            </p>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="bg-ink-900">
          <div className="mx-auto max-w-3xl px-4 py-16 text-center">
            <h2 className="text-2xl sm:text-3xl font-semibold text-white">
              {t("landing.footerCta")}
            </h2>
            <div className="mt-8 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center sm:justify-center gap-3">
              <LinkButton href="/explore" size="lg" variant="inverse" className="w-full sm:w-auto">
                {t("landing.ctaExplore")}
              </LinkButton>
              <LinkButton
                href="/register?role=MEDIA_OWNER"
                size="lg"
                variant="inverseGhost"
                className="w-full sm:w-auto"
              >
                {t("landing.ctaOwner")}
              </LinkButton>
            </div>
            <p className="mt-6 text-sm text-ink-300">
              {t("landing.footerLogin")}{" "}
              <a href="/login" className="text-white underline underline-offset-4 hover:text-ink-100">
                {t("auth.login")}
              </a>
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
