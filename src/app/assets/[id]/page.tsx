import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getPublicAsset, assetAvailability } from "@/server/assets";
import { getCurrentUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { priceLine } from "@/lib/price";
import { formatDate, formatRange, todayUtc } from "@/lib/dates";
import { AvailabilityBadge, VerificationBadge } from "@/components/badges";
import { Card, Collapsible, ImagePlaceholder, Num, PageSection, Price, buttonClass } from "@/components/ui";
import { AssetMiniMap } from "@/components/map/AssetMiniMap";
import { RequestPanel } from "@/components/request/RequestPanel";
import { SaveAssetButton } from "@/components/SaveAssetButton";
import { CreativeMockup } from "@/components/assets/CreativeMockup";
import { faceRatio, parseQuad } from "@/lib/mockup";
import { isShowable } from "@/lib/surface-confidence";
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

/**
 * One line of the specification.
 *
 * No rule under each row. Twenty specification lines with twenty hairlines is
 * a table of contents for nothing - the label column already separates them,
 * and the rules were the single densest thing on the page. The grid keeps the
 * values aligned, which is what the rules were really doing.
 */
function Spec({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5 py-1.5">
      <dt className="text-sm text-ink-500">{label}</dt>
      <dd className="text-sm text-ink-900 min-w-0">{value}</dd>
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
          {/* "Opens with an account" is true for a visitor and insulting to a
              customer who is signed in and looking at it. Same page, two
              audiences, two headings. */}
          <h1 className="mt-1 text-xl font-semibold text-ink-900">
            {viewer.signedIn ? t("access.restrictedAssetSignedIn") : t("access.restrictedAsset")}
          </h1>
          <p className="mt-2 text-sm text-ink-700">
            {viewer.signedIn
              ? t("access.restrictedAssetSignedInNote")
              : t("access.restrictedAssetNote")}
          </p>
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
      /*
       * Who marked the face, and how sure they were.
       *
       * The filter below turns on this rather than on the quad alone: a
       * detection the rules sent to review is stored, because a person can
       * correct it, but it must not reach this page at all. Not hidden with
       * CSS, not rendered and skipped - absent, so a quad nobody has vouched
       * for is never in the HTML a customer receives.
       */
      detected: image.surfaceSource === "ai",
      confidence: image.surfaceConfidence,
      source: image.surfaceSource,
    }))
    .filter(
      (p): p is {
        id: string;
        url: string;
        quad: NonNullable<typeof p.quad>;
        angleDeg: number | null;
        detected: boolean;
        confidence: number | null;
        source: string | null;
      } =>
        p.quad != null &&
        isShowable(
          {
            quad: p.quad,
            confidence: p.confidence,
            source: p.source === "ai" || p.source === "admin" ? p.source : null,
          },
          asset
        )
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

      <div className="grid lg:grid-cols-[1fr_380px] gap-6 lg:gap-10 items-start">
        {/*
          A flat column, not a stack of cards.

          This page used to be eight bordered, shadowed panels one under the
          other, each claiming the same visual rank. An advertiser opening a
          listing wants five things - what it looks like, what it is called,
          where it is, what it costs, and whether they can have the dates -
          and all five were competing with the illumination type and the
          permit status for attention.

          So: the five stay above the fold and unboxed, the rest moves behind
          a disclosure, and the only object on the page that is allowed to
          look like a floating panel is the request form, because that is the
          thing the page is for.
        */}
        <div className="min-w-0">
          {/* Hero */}
          <div className="overflow-hidden rounded-lg border border-ink-200">
            {primary ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={primary.url} alt={asset.title} className="aspect-[16/9] w-full object-cover" />
            ) : (
              <ImagePlaceholder label={t("asset.noImagesLong")} className="aspect-[16/9] w-full" />
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-start gap-3">
            <h1 className="text-xl sm:text-2xl font-semibold text-ink-900 flex-1 min-w-0">{asset.title}</h1>
            <SaveAssetButton assetId={asset.id} initiallySaved={saved} signedIn={!!user} />
          </div>

          {/*
            Address, verification and availability on one line.

            These were a paragraph and then a row of three bordered pills. Two
            of the three were the ordinary case on every listing in the
            product, and the third repeated the second: an unverified asset
            reports its availability as PENDING_VERIFICATION, so the page
            showed the words "ממתין לאימות" twice side by side, which read as
            a rendering fault. The verification mark is the one that means it.
          */}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-600">
            <span>
              {asset.city} · {asset.address}
            </span>
            <span aria-hidden="true" className="text-ink-300">
              ·
            </span>
            <VerificationBadge status={asset.verificationStatus} />
            {availability !== "PENDING_VERIFICATION" && (
              <>
                <span aria-hidden="true" className="text-ink-300">
                  ·
                </span>
                <AvailabilityBadge state={availability} />
              </>
            )}
          </p>

          {/*
            The three caveats, as lines rather than as boxes.

            Each of these used to be a tinted, bordered block, so a listing
            that was both unverified and seeded opened with two coloured
            warning panels above its own description. They are footnotes about
            provenance, and they now read like footnotes - same words, same
            order, no furniture.
          */}
          {(asset.verificationStatus === "PENDING" ||
            (asset.verificationStatus === "VERIFIED" && asset.verifiedAt) ||
            asset.isDemo) && (
            <div className="mt-2 space-y-0.5 text-xs text-ink-500">
              {asset.verificationStatus === "PENDING" && <p>{t("verify.PENDING.help")}</p>}
              {/* A verification mark that names no date asks to be taken on
                  faith. verifiedAt is already stored - saying when turns it
                  into a checkable claim. */}
              {asset.verificationStatus === "VERIFIED" && asset.verifiedAt && (
                <p>
                  {t("verify.VERIFIED.when")} <Num>{formatDate(asset.verifiedAt)}</Num>
                </p>
              )}
              {asset.isDemo && <p>{t("common.demoDataNote")}</p>}
            </div>
          )}

          {asset.description && (
            <p className="mt-4 text-sm text-ink-800 leading-relaxed whitespace-pre-line">
              {asset.description}
            </p>
          )}

          {/* A thumbnail strip rather than a grid of squares: the extra
              photographs are supporting evidence for the one above, not a
              gallery in their own right. */}
          {asset.images.length > 1 && (
            <div className="mt-4">
              <h2 className="sr-only">{t("asset.morePhotos")}</h2>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {asset.images.slice(1).map((img) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={img.id}
                    src={img.url}
                    alt=""
                    loading="lazy"
                    className="h-20 w-28 shrink-0 object-cover rounded border border-ink-200"
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-8 space-y-6">
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
          </div>

          {/* Availability windows: the one remaining question the hero does not
              answer, so it stays open rather than folding away. */}
          <PageSection title={t("asset.availabilityPeriods")} className="mt-8">
            {futurePeriods.length === 0 ? (
              <p className="text-sm text-ink-500">{t("asset.noPeriods")}</p>
            ) : (
              <ul className="space-y-1.5">
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
          </PageSection>

          {/* Location */}
          <PageSection title={t("asset.location")} className="mt-6">
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
          </PageSection>

          {/* Specifications - folded, with the two facts most people open it
              for shown on the closed row. */}
          <Collapsible
            title={t("asset.specs")}
            summary={
              asset.widthCm && asset.heightCm
                ? `${t(`type.${asset.assetType}`)} · ${asset.widthCm}×${asset.heightCm} ס״מ`
                : t(`type.${asset.assetType}`)
            }
          >
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
          </Collapsible>

          {/* Commercial. The headline price is already at the top of the
              request panel, so what is folded here is the breakdown. */}
          <Collapsible
            title={t("asset.commercial")}
            summary={headlinePrice.amount != null ? headlinePrice.text : t("asset.priceNotPublished")}
          >
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
          </Collapsible>

          {/* Owner - company-level contact only, never a personal phone/email */}
          <Collapsible title={t("asset.owner")} summary={asset.company?.name ?? t("common.notProvided")}>
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
          </Collapsible>
          {/* Closes the last disclosure, so the column ends on a rule rather
              than on an open edge. */}
          <div className="border-t border-ink-200" />
        </div>

        {/* Request panel */}
        <div id="request" className="lg:sticky lg:top-20 pb-20 lg:pb-0">
          <RequestPanel
            assetId={asset.id}
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
