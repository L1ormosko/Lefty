"use client";

import Link from "next/link";
import type { MapAsset } from "@/server/assets";
import { CURRENCY } from "@/lib/constants";
import { t } from "@/lib/labels";
import { formatDate } from "@/lib/dates";
import { AvailabilityBadge, DemoBadge, VerificationBadge } from "@/components/badges";
import { ImagePlaceholder, Num, cx } from "@/components/ui";

export function AssetCard({
  asset,
  selected,
  onSelect,
}: {
  asset: MapAsset;
  selected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const priceLabel =
    asset.priceMonthly != null
      ? `${t("asset.priceFrom")}${CURRENCY}${asset.priceMonthly.toLocaleString("he-IL")} / חודש`
      : asset.priceWeekly != null
        ? `${t("asset.priceFrom")}${CURRENCY}${asset.priceWeekly.toLocaleString("he-IL")} / שבוע`
        : t("asset.priceNotPublished");

  return (
    <article
      className={cx(
        "bg-white border rounded-lg overflow-hidden transition-colors",
        selected ? "border-brand-500 ring-1 ring-brand-500" : "border-ink-200 hover:border-ink-300"
      )}
    >
      <button
        type="button"
        onClick={() => onSelect?.(asset.id)}
        className="w-full text-start flex gap-3 p-3"
        aria-pressed={selected}
      >
        <div className="size-20 shrink-0 rounded overflow-hidden">
          {asset.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={asset.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <ImagePlaceholder label={t("asset.noImages")} className="size-full" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="font-medium text-sm text-ink-900 line-clamp-2 flex-1">{asset.title}</h3>
          </div>
          <p className="text-xs text-ink-500 mt-0.5 truncate">
            {asset.city} · {asset.address}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <AvailabilityBadge
              state={asset.availability}
              size="sm"
              note={
                asset.availability !== "AVAILABLE" && asset.nextAvailable
                  ? `${t("common.from")}${formatDate(asset.nextAvailable)}`
                  : undefined
              }
            />
            <VerificationBadge status={asset.verificationStatus as "PENDING" | "VERIFIED"} size="sm" />
            {asset.isDemo && <DemoBadge />}
          </div>
          <p className="mt-2 text-sm font-medium text-ink-900">
            <Num>{priceLabel}</Num>
          </p>
        </div>
      </button>
      <div className="border-t border-ink-100 px-3 py-2">
        <Link href={`/assets/${asset.id}`} className="text-sm text-brand-600 hover:underline font-medium">
          {t("asset.requestAvailability")} ←
        </Link>
      </div>
    </article>
  );
}
