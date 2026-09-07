import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getPublicAsset, assetAvailability } from "@/server/assets";
import { getCurrentUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { CURRENCY } from "@/lib/constants";
import { formatRange, todayUtc } from "@/lib/dates";
import { AvailabilityBadge, DemoBadge, VerificationBadge } from "@/components/badges";
import { Card, ImagePlaceholder, Num } from "@/components/ui";
import { AssetMiniMap } from "@/components/map/AssetMiniMap";
import { RequestPanel } from "@/components/request/RequestPanel";
import { SaveAssetButton } from "@/components/SaveAssetButton";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const asset = await getPublicAsset(id);
  if (!asset) return { title: "שטח לא נמצא" };
  const description = `${t(`type.${asset.assetType}`)} ב${asset.city}, ${asset.address}.`;
  return {
    title: asset.title,
    description,
    openGraph: {
      title: `${asset.title} | VELTO`,
      description,
      images: asset.images[0]?.url ? [{ url: asset.images[0].url }] : undefined,
    },
  };
}

function Spec({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="py-2 flex items-baseline gap-3 border-b border-ink-100 last:border-0">
      <dt className="text-sm text-ink-500 w-36 shrink-0">{label}</dt>
      <dd className="text-sm text-ink-900">{value}</dd>
    </div>
  );
}

const unknown = <span className="text-ink-400">{t("common.notProvided")}</span>;

export default async function AssetPage({ params }: Params) {
  const { id } = await params;
  const user = await getCurrentUser();
  const asset = await getPublicAsset(id, user);
  if (!asset) notFound();

  const saved = user
    ? (await prisma.savedAsset.findUnique({
        where: { userId_assetId: { userId: user.id, assetId: asset.id } },
        select: { id: true },
      })) != null
    : false;

  const availability = assetAvailability(asset);
  const primary = asset.images[0];
  const futurePeriods = asset.periods.filter((p) => p.endDate >= todayUtc());

  const priceLine =
    asset.priceMonthly != null
      ? `${t("asset.priceFrom")}${CURRENCY}${asset.priceMonthly.toLocaleString("he-IL")} / חודש`
      : asset.priceWeekly != null
        ? `${t("asset.priceFrom")}${CURRENCY}${asset.priceWeekly.toLocaleString("he-IL")} / שבוע`
        : null;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <nav className="mb-4 text-sm">
        <Link href="/" className="text-brand-600 hover:underline">
          → {t("asset.backToMap")}
        </Link>
      </nav>

      <div className="grid lg:grid-cols-[1fr_380px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          {/* Hero */}
          <Card className="overflow-hidden">
            {primary ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={primary.url} alt={asset.title} className="aspect-[16/9] w-full object-cover" />
            ) : (
              <ImagePlaceholder label={t("asset.noImagesLong")} className="aspect-[16/9] w-full" />
            )}
            <div className="p-5">
              <div className="flex flex-wrap items-start gap-3">
                <h1 className="text-xl sm:text-2xl font-semibold text-ink-900 flex-1 min-w-0">{asset.title}</h1>
                <SaveAssetButton assetId={asset.id} initiallySaved={saved} signedIn={!!user} />
              </div>
              <p className="mt-1 text-sm text-ink-600">
                {asset.city} · {asset.address}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <AvailabilityBadge state={availability} />
                <VerificationBadge status={asset.verificationStatus} />
                {asset.isDemo && <DemoBadge />}
              </div>
              {asset.verificationStatus === "PENDING" && (
                <p className="mt-3 text-sm text-ink-600 bg-ink-50 border border-ink-200 rounded p-3">
                  {t("verify.PENDING.help")}
                </p>
              )}
              {asset.isDemo && (
                <p className="mt-3 text-sm text-ink-600 bg-warn-50 border border-warn-500/30 rounded p-3">
                  {t("common.demoDataNote")}
                </p>
              )}
              {asset.description && (
                <p className="mt-4 text-sm text-ink-800 leading-relaxed whitespace-pre-line">
                  {asset.description}
                </p>
              )}
            </div>
          </Card>

          {asset.images.length > 1 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {asset.images.slice(1).map((img) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={img.id}
                  src={img.url}
                  alt=""
                  loading="lazy"
                  className="aspect-square object-cover rounded border border-ink-200"
                />
              ))}
            </div>
          )}

          {/* Location */}
          <Card className="p-5">
            <h2 className="font-semibold text-ink-900 mb-3">{t("asset.location")}</h2>
            <p className="text-sm text-ink-700">
              {asset.address}, {asset.city}
              {asset.region ? ` · ${asset.region}` : ""}
            </p>
            <div className="mt-3 h-64 rounded-md overflow-hidden border border-ink-200">
              <AssetMiniMap
                latitude={asset.latitude}
                longitude={asset.longitude}
                availability={availability}
              />
            </div>
          </Card>

          {/* Specifications */}
          <Card className="p-5">
            <h2 className="font-semibold text-ink-900 mb-2">{t("asset.specs")}</h2>
            <dl>
              <Spec label={t("asset.type")} value={t(`type.${asset.assetType}`)} />
              <Spec
                label={t("asset.dimensions")}
                value={
                  asset.widthCm && asset.heightCm ? (
                    <Num>{`${asset.widthCm} × ${asset.heightCm} ס״מ`}</Num>
                  ) : (
                    unknown
                  )
                }
              />
              <Spec label={t("asset.orientation")} value={asset.orientation || unknown} />
              <Spec label={t("asset.sides")} value={<Num>{asset.sides}</Num>} />
              <Spec label={t("asset.illumination")} value={t(`illum.${asset.illumination}`)} />
              <Spec
                label={t("asset.digital")}
                value={asset.isDigital ? t("asset.digital") : t("asset.static")}
              />
              <Spec
                label={t("asset.permit")}
                value={
                  <span>
                    {t(`permit.${asset.permitStatus}`)}
                    <span className="block text-xs text-ink-500 mt-0.5">{t("permit.note")}</span>
                  </span>
                }
              />
            </dl>
          </Card>

          {/* Commercial */}
          <Card className="p-5">
            <h2 className="font-semibold text-ink-900 mb-2">{t("asset.commercial")}</h2>
            <dl>
              <Spec
                label={t("asset.priceWeekly")}
                value={
                  asset.priceWeekly != null ? (
                    <Num>{`${CURRENCY}${asset.priceWeekly.toLocaleString("he-IL")}`}</Num>
                  ) : (
                    unknown
                  )
                }
              />
              <Spec
                label={t("asset.priceMonthly")}
                value={
                  asset.priceMonthly != null ? (
                    <Num>{`${CURRENCY}${asset.priceMonthly.toLocaleString("he-IL")}`}</Num>
                  ) : (
                    unknown
                  )
                }
              />
              <Spec
                label={t("asset.minimumBooking")}
                value={
                  <span>
                    <Num>{asset.minimumBookingDays}</Num> {t("asset.days")}
                  </span>
                }
              />
              <Spec
                label={t("asset.extras")}
                value={
                  [
                    asset.productionIncluded && t("asset.production"),
                    asset.installationIncluded && t("asset.installation"),
                    asset.removalIncluded && t("asset.removal"),
                  ]
                    .filter(Boolean)
                    .join(" · ") || t("asset.notIncluded")
                }
              />
            </dl>
            {priceLine && <p className="mt-3 text-xs text-ink-500">{t("asset.priceEstimateNote")}</p>}
          </Card>

          {/* Availability windows */}
          <Card className="p-5">
            <h2 className="font-semibold text-ink-900 mb-3">{t("asset.availabilityPeriods")}</h2>
            {futurePeriods.length === 0 ? (
              <p className="text-sm text-ink-500">{t("asset.noPeriods")}</p>
            ) : (
              <ul className="space-y-2">
                {futurePeriods.map((p) => (
                  <li key={p.id} className="text-sm text-ink-800 flex items-center gap-2">
                    <span className="text-ok-500" aria-hidden="true">
                      ●
                    </span>
                    <Num>{formatRange(p.startDate, p.endDate)}</Num>
                    {p.note && <span className="text-ink-500">— {p.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Owner - company-level contact only */}
          <Card className="p-5">
            <h2 className="font-semibold text-ink-900 mb-2">{t("asset.owner")}</h2>
            <p className="text-sm text-ink-800">{asset.company?.name ?? t("common.notProvided")}</p>
            {asset.company?.website && (
              <a
                href={asset.company.website}
                rel="noopener noreferrer nofollow"
                target="_blank"
                className="text-sm text-brand-600 hover:underline"
              >
                {asset.company.website}
              </a>
            )}
          </Card>
        </div>

        {/* Request panel */}
        <div className="lg:sticky lg:top-20">
          <RequestPanel
            assetId={asset.id}
            title={asset.title}
            priceLine={priceLine}
            minimumBookingDays={asset.minimumBookingDays}
            instantBookable={asset.instantBookable}
            availability={availability}
            signedIn={!!user}
            defaults={
              user ? { contactName: user.name, contactEmail: user.email, contactPhone: user.phone ?? "" } : undefined
            }
          />
        </div>
      </div>
    </main>
  );
}
