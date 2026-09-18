import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getPublicAsset, assetAvailability } from "@/server/assets";
import { getCurrentUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { priceLine } from "@/lib/price";
import { formatDate, formatRange, todayUtc } from "@/lib/dates";
import { AvailabilityBadge, DemoBadge, VerificationBadge } from "@/components/badges";
import { Card, ImagePlaceholder, Num, Price, buttonClass } from "@/components/ui";
import { AssetMiniMap } from "@/components/map/AssetMiniMap";
import { RequestPanel } from "@/components/request/RequestPanel";
import { SaveAssetButton } from "@/components/SaveAssetButton";
import { CreativeMockup } from "@/components/assets/CreativeMockup";
import { faceRatio, isUsableQuad, parseQuad } from "@/lib/mockup";
import { StreetViewPanel } from "@/components/assets/StreetViewPanel";
import { AccessNotice } from "@/components/access/AccessNotice";
import { viewerAccess } from "@/server/subscription";
import { safeExternalUrl } from "@/lib/validation";

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

  // A listing page is the thing VELTO sells: address, price, free dates,
  // contact and the creative preview. Without access the page still exists -
  // it says what kind of sign and which city, so the link is shareable and
  // indexable - but it stops short of the detail.
  const viewer = await viewerAccess(user);
  if (!viewer.full) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6">
        <nav className="mb-4 text-sm">
          <Link href="/explore" className="text-brand-600 hover:underline">
            → {t("asset.backToMap")}
          </Link>
        </nav>
        <Card className="p-5">
          <p className="text-sm text-ink-500">
            {t(`type.${asset.assetType}`)} · {asset.city}
          </p>
          <h1 className="mt-1 text-xl font-semibold text-ink-900">
            {t("access.restrictedAsset")}
          </h1>
          <p className="mt-2 text-sm text-ink-700">{t("access.restrictedAssetNote")}</p>
          <AccessNotice access={viewer} className="mt-4" />
        </Card>
      </main>
    );
  }

  const saved = user
    ? (await prisma.savedAsset.findUnique({
        where: { userId_assetId: { userId: user.id, assetId: asset.id } },
        select: { id: true },
      })) != null
    : false;

  const availability = assetAvailability(asset);
  const primary = asset.images[0];

  // Every photo with a face marked on it, in order. Usually one - a close-up
  // of the sign - but an owner who also uploaded a wide shot of the street
  // gives the advertiser the second thing they actually want to know: how the
  // ad sits in its surroundings. Both are real photographs of the site.
  const mockupPhotos = asset.images
    .map((image) => ({
      id: image.id,
      url: image.url,
      quad: parseQuad(image.surfaceQuad),
      // Where the camera stood, when the owner said. The panel orders the
      // angles by it and labels them; null keeps the upload order.
      angleDeg: image.viewAngleDeg,
    }))
    .filter(
      (p): p is { id: string; url: string; quad: NonNullable<typeof p.quad>; angleDeg: number | null } =>
        p.quad != null && isUsableQuad(p.quad)
    );
  const futurePeriods = asset.periods.filter((p) => p.endDate >= todayUtc());

  const headlinePrice = priceLine(asset);
  // An owner-supplied link, checked before it becomes an href. Rows written
  // before the schema allow-listed http(s) could still carry a javascript:
  // URL, which would be stored XSS against every advertiser who opened the
  // listing; null means the link is simply not rendered.
  const companyWebsite = safeExternalUrl(asset.company?.website);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <nav className="mb-4 text-sm">
        <Link href="/explore" className="text-brand-600 hover:underline">
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
                {/* An unverified asset reports its availability as
                    PENDING_VERIFICATION, which renders the identical words the
                    verification badge beside it already says. Two adjacent
                    badges reading "ממתין לאימות" looked like a rendering bug.
                    The verification badge is the one that means it. */}
                {availability !== "PENDING_VERIFICATION" && <AvailabilityBadge state={availability} />}
                <VerificationBadge status={asset.verificationStatus} />
                {asset.isDemo && <DemoBadge />}
              </div>
              {asset.verificationStatus === "PENDING" && (
                <p className="mt-3 text-sm text-ink-600 bg-ink-50 border border-ink-200 rounded p-3">
                  {t("verify.PENDING.help")}
                </p>
              )}
              {/* A verification badge that names nobody and no date asks to be
                  taken on faith. verifiedAt is already stored - saying when
                  turns the badge into a checkable claim. */}
              {asset.verificationStatus === "VERIFIED" && asset.verifiedAt && (
                <p className="mt-3 text-xs text-ink-500">
                  {t("verify.VERIFIED.when")} <Num>{formatDate(asset.verifiedAt)}</Num>
                </p>
              )}
              {asset.isDemo && (
                <p className="mt-3 text-sm text-ink-600 bg-warn-50 border border-warn-200 rounded p-3">
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

          {/* The creative preview, only where someone has marked a face to put
              it on. No marked quad means no honest place for the artwork, and
              a guessed rectangle would show an ad that does not fit the sign. */}
          {mockupPhotos.length > 0 && (
            <CreativeMockup
              photos={mockupPhotos}
              faceRatio={faceRatio(asset)}
              widthCm={asset.widthCm}
              heightCm={asset.heightCm}
            />
          )}

          {/* Google's own imagery of the address, untouched and in its own
              panel. Their terms forbid altering Street View images - an ad
              painted onto one would be exactly that - so the preview above
              stays on the site's real photograph and this answers "what is
              actually there" separately. */}
          <StreetViewPanel latitude={asset.latitude} longitude={asset.longitude} />

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
              {/*
                Surroundings as the owner described them. Rendered with the
                "declared, not measured" line attached, because this is the
                field an advertiser is most likely to read as an audience
                claim - and VELTO measures nothing.
              */}
              <Spec
                label={t("tag.sectionTitle")}
                value={
                  asset.locationTags.length === 0 ? (
                    <span className="text-ink-400">{t("tag.none")}</span>
                  ) : (
                    <span>
                      {asset.locationTags.map((tag) => t(`tag.${tag}`)).join(" · ")}
                      <span className="block text-xs text-ink-500 mt-0.5">{t("tag.declared")}</span>
                    </span>
                  )
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
                    <Price amount={asset.priceWeekly} />
                  ) : (
                    unknown
                  )
                }
              />
              <Spec
                label={t("asset.priceMonthly")}
                value={
                  asset.priceMonthly != null ? (
                    <Price amount={asset.priceMonthly} />
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
            {headlinePrice.amount != null && (
              <p className="mt-3 text-xs text-ink-500">{t("asset.priceEstimateNote")}</p>
            )}
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

          {/* Owner - company-level contact only, never a personal phone/email */}
          <Card className="p-5">
            <h2 className="font-semibold text-ink-900 mb-2">{t("asset.owner")}</h2>
            <p className="text-sm text-ink-800">{asset.company?.name ?? t("common.notProvided")}</p>
            <div className="mt-1 space-y-1">
              {asset.company?.contactEmail && (
                <a
                  href={`mailto:${asset.company.contactEmail}`}
                  dir="ltr"
                  className="block text-sm text-brand-600 hover:underline w-fit"
                >
                  {asset.company.contactEmail}
                </a>
              )}
              {asset.company?.contactPhone && (
                <a
                  href={`tel:${asset.company.contactPhone}`}
                  className="block text-sm text-brand-600 hover:underline w-fit"
                >
                  <Num>{asset.company.contactPhone}</Num>
                </a>
              )}
              {companyWebsite && (
                <a
                  href={companyWebsite}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                  className="block text-sm text-brand-600 hover:underline w-fit"
                >
                  {companyWebsite}
                </a>
              )}
            </div>
          </Card>
        </div>

        {/* Request panel */}
        <div id="request" className="lg:sticky lg:top-20 pb-20 lg:pb-0">
          <RequestPanel
            assetId={asset.id}
            title={asset.title}
            priceLine={headlinePrice.amount != null ? headlinePrice.text : null}
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

      {/*
        On a phone the request form sits under roughly 2,500px of specification,
        pricing, availability and owner detail, with nothing at the top offering
        a way down to it. This bar is the way down. Desktop already has the
        panel pinned beside the content, so it only exists on small screens.
        scroll-padding-top in globals.css keeps the target clear of the sticky
        header.
      */}
      <div className="lg:hidden fixed inset-x-0 bottom-0 z-20 border-t border-ink-200 bg-white/95 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink-900 truncate">
              {headlinePrice.text}
            </p>
          </div>
          {/* A shorter label than the panel's own heading: the full
              "בדיקת זמינות ומחיר" truncates inside a bar that also shows the price. */}
          <a href="#request" className={buttonClass("primary", "md", "shrink-0 whitespace-nowrap")}>
            {t("asset.requestShort")}
          </a>
        </div>
      </div>
    </main>
  );
}
