import Link from "next/link";
import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { countOpenRequests } from "@/server/access-requests";
import { DashboardShell } from "@/components/DashboardShell";
import { Card, EmptyState, LinkButton, Num, cx } from "@/components/ui";
import { DemoBadge, StatusPill, VerificationBadge } from "@/components/badges";
import { VerifyAssetForm } from "@/components/admin/VerifyAssetForm";
import { MarkSurfaceForm } from "@/components/admin/MarkSurfaceForm";
import { parseQuad } from "@/lib/mockup";
import { isShowable } from "@/lib/surface-confidence";
import { StreetViewPanel } from "@/components/assets/StreetViewPanel";
import { DetectSurfacesForm } from "@/components/admin/DetectSurfacesForm";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "pending", label: t("verify.PENDING") },
  { key: "verified", label: t("verify.VERIFIED") },
  { key: "rejected", label: t("verify.REJECTED") },
  // Listings carrying a face a model found. Filtered on provenance rather
  // than on "needs review", and the distinction is honest rather than
  // pedantic: whether a detection is live depends on the shape check in
  // lib/surface-confidence.ts, which is geometry and cannot be expressed as
  // a WHERE clause. A tab that promised "exactly the ones awaiting you" would
  // quietly miss those, so it promises what it can deliver and each photo
  // says its own state.
  { key: "detected", label: t("admin.surfaceDetected") },
  { key: "all", label: "הכול" },
] as const;

/** Any photo on the listing whose face came from a detection. */
const DETECTED_WHERE = { images: { some: { surfaceSource: "ai" } } };

export default async function AdminAssets({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  await requireRole("ADMIN");
  const { filter = "pending", page: pageParam } = await searchParams;
  const page = pageFromParam(pageParam);
  const where =
    filter === "verified"
      ? { verificationStatus: "VERIFIED" as const }
      : filter === "rejected"
        ? { verificationStatus: "REJECTED" as const }
        : filter === "detected"
          ? DETECTED_WHERE
          : filter === "all"
            ? {}
            : { verificationStatus: "PENDING" as const, status: { not: "DRAFT" as const } };

  // Counts on every tab. The default view is "pending" because that is the
  // admin's actual queue, but with 0 pending assets it opened on a bare empty
  // state that read as a broken page while 16 assets sat one tab away. A tab
  // labelled 0 next to one labelled 16 explains itself.
  const pendingWhere = { verificationStatus: "PENDING" as const, status: { not: "DRAFT" as const } };
  const [countPending, countVerified, countRejected, countDetected, countAll] = await Promise.all([
    prisma.mediaAsset.count({ where: pendingWhere }),
    prisma.mediaAsset.count({ where: { verificationStatus: "VERIFIED" } }),
    prisma.mediaAsset.count({ where: { verificationStatus: "REJECTED" } }),
    prisma.mediaAsset.count({ where: DETECTED_WHERE }),
    prisma.mediaAsset.count(),
  ]);
  // Photographs nobody and nothing has looked at. Counted here rather than
  // inside the form so the form can render nothing at all when it is zero.
  const uncheckedImages = await prisma.mediaAssetImage.count({
    where: { surfaceCheckedAt: null, surfaceSource: null },
  });
  const counts: Record<string, number> = {
    pending: countPending,
    verified: countVerified,
    rejected: countRejected,
    detected: countDetected,
    all: countAll,
  };

  const assets = await prisma.mediaAsset.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: PAGE_SIZE,
    skip: skipFor(page),
    include: {
      owner: { select: { id: true, name: true, email: true } },
      company: { select: { name: true } },
      // Every photo, because every photo can carry a marked face. The
      // advertiser's preview offers each marked one as a separate view - a
      // close-up of the sign, and a wide shot of it in the street - so
      // marking only the primary would cap the feature at one viewpoint.
      images: {
        orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }],
        select: {
          id: true,
          url: true,
          surfaceQuad: true,
          viewAngleDeg: true,
          surfaceSource: true,
          surfaceConfidence: true,
          surfaceCheckedAt: true,
        },
      },
    },
  });

  return (
    <DashboardShell title={t("admin.assets")} nav={adminNav({ access: await countOpenRequests() })} current="/admin/assets">
      <DetectSurfacesForm pending={uncheckedImages} />

      <div className="flex gap-1.5 mb-4 overflow-x-auto">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/admin/assets?filter=${f.key}`}
            className={cx(
              "rounded-md px-3 h-8 inline-flex items-center text-sm border whitespace-nowrap",
              filter === f.key ? "bg-ink-900 text-white border-ink-900" : "bg-white border-ink-200 text-ink-700"
            )}
          >
            {f.label}
            <span
              className={cx(
                "ms-1.5 text-xs tabular-nums",
                filter === f.key ? "text-white/70" : "text-ink-400"
              )}
            >
              <Num>{counts[f.key]}</Num>
            </span>
          </Link>
        ))}
      </div>

      {assets.length === 0 ? (
        <EmptyState
          title="אין שטחים בסטטוס זה."
          hint={countAll > 0 ? `במערכת יש ${countAll} שטחים בסטטוסים אחרים.` : undefined}
          action={
            countAll > 0 && filter !== "all" ? (
              <LinkButton href="/admin/assets?filter=all" variant="secondary" size="sm">
                הצגת כל השטחים
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <>
        <div className="space-y-3">
          {assets.map((asset) => (
            // data-admin-asset scopes a test (or a person reading the DOM) to
            // one listing's row: the marking controls repeat per card, and a
            // page-wide selector picks whichever happens to be first.
            <div key={asset.id} data-admin-asset={asset.id}>
            <Card className="p-4">
              <div className="flex flex-wrap gap-2 items-start">
                <div className="min-w-0 flex-1">
                  <Link href={`/assets/${asset.id}`} className="font-medium text-ink-900 hover:underline">
                    {asset.title || "—"}
                  </Link>
                  <p className="text-sm text-ink-500 mt-0.5">
                    {asset.city || t("common.notProvided")} · {asset.address || "—"} ·{" "}
                    <Num>{`${asset.latitude.toFixed(4)}, ${asset.longitude.toFixed(4)}`}</Num>
                  </p>
                  <p className="text-sm text-ink-600 mt-1">
                    {t("asset.owner")}: {asset.owner.name}{" "}
                    <span dir="ltr" className="text-ink-500">
                      ({asset.owner.email})
                    </span>
                    {asset.company && ` · ${asset.company.name}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <StatusPill label={t(`status.${asset.status}`)} tone={asset.status === "ACTIVE" ? "ok" : "neutral"} />
                  {/* This page IS the verification queue, so "pending" is the
                      state the admin is here to act on - the one place it
                      earns a box. */}
                  <VerificationBadge status={asset.verificationStatus} size="sm" tone="loud" />
                  {asset.isDemo && <DemoBadge />}
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-ink-100">
                <VerifyAssetForm assetId={asset.id} status={asset.status} note={asset.reviewNote} />
                {asset.images.map((image) => {
                  const quad = parseQuad(image.surfaceQuad);
                  return (
                    <MarkSurfaceForm
                      key={image.id}
                      imageId={image.id}
                      photoUrl={image.url}
                      initialQuad={quad}
                      initialAngle={image.viewAngleDeg}
                      detection={{
                        source: image.surfaceSource,
                        confidence: image.surfaceConfidence,
                        checked: image.surfaceCheckedAt != null,
                        // The same derivation the listing page renders on, so
                        // the queue cannot tell the admin a face is live while
                        // the customer sees nothing - or the reverse.
                        live:
                          quad != null &&
                          isShowable(
                            {
                              quad,
                              confidence: image.surfaceConfidence,
                              source:
                                image.surfaceSource === "ai" || image.surfaceSource === "admin"
                                  ? image.surfaceSource
                                  : null,
                            },
                            asset
                          ),
                      }}
                    />
                  );
                })}

                {/* Google's own view of the address, so the admin can check
                    the photograph is of this place before vouching for where
                    the sign is in it. Unmodified and embedded, exactly as on
                    the listing page - it is a reference, never a canvas. */}
                {asset.images.length > 0 && (
                  <StreetViewPanel latitude={asset.latitude} longitude={asset.longitude} />
                )}
              </div>
            </Card>
            </div>
          ))}
        </div>
        {/* The tab has to survive paging, or page 2 of "rejected" silently
            becomes page 2 of "pending". */}
        <Pager page={page} total={counts[filter] ?? countAll} basePath="/admin/assets" params={{ filter }} />
        </>
      )}
    </DashboardShell>
  );
}
