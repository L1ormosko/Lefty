import Link from "next/link";
import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { Card, EmptyState, LinkButton, Num, cx } from "@/components/ui";
import { DemoBadge, StatusPill, VerificationBadge } from "@/components/badges";
import { VerifyAssetForm } from "@/components/admin/VerifyAssetForm";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "pending", label: t("verify.PENDING") },
  { key: "verified", label: t("verify.VERIFIED") },
  { key: "rejected", label: t("verify.REJECTED") },
  { key: "all", label: "הכול" },
] as const;

export default async function AdminAssets({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  await requireRole("ADMIN");
  const { filter = "pending" } = await searchParams;
  const where =
    filter === "verified"
      ? { verificationStatus: "VERIFIED" as const }
      : filter === "rejected"
        ? { verificationStatus: "REJECTED" as const }
        : filter === "all"
          ? {}
          : { verificationStatus: "PENDING" as const, status: { not: "DRAFT" as const } };

  // Counts on every tab. The default view is "pending" because that is the
  // admin's actual queue, but with 0 pending assets it opened on a bare empty
  // state that read as a broken page while 16 assets sat one tab away. A tab
  // labelled 0 next to one labelled 16 explains itself.
  const pendingWhere = { verificationStatus: "PENDING" as const, status: { not: "DRAFT" as const } };
  const [countPending, countVerified, countRejected, countAll] = await Promise.all([
    prisma.mediaAsset.count({ where: pendingWhere }),
    prisma.mediaAsset.count({ where: { verificationStatus: "VERIFIED" } }),
    prisma.mediaAsset.count({ where: { verificationStatus: "REJECTED" } }),
    prisma.mediaAsset.count(),
  ]);
  const counts: Record<string, number> = {
    pending: countPending,
    verified: countVerified,
    rejected: countRejected,
    all: countAll,
  };

  const assets = await prisma.mediaAsset.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      owner: { select: { id: true, name: true, email: true } },
      company: { select: { name: true } },
    },
  });

  return (
    <DashboardShell title={t("admin.assets")} nav={adminNav()} current="/admin/assets">
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
        <div className="space-y-3">
          {assets.map((asset) => (
            <Card key={asset.id} className="p-4">
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
                  <VerificationBadge status={asset.verificationStatus} size="sm" />
                  {asset.isDemo && <DemoBadge />}
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-ink-100">
                <VerifyAssetForm assetId={asset.id} status={asset.status} note={asset.reviewNote} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
