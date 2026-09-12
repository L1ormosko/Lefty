"use client";

import Link from "next/link";
import type { MapAsset } from "@/server/assets";
import { t } from "@/lib/labels";
import { priceLine } from "@/lib/price";
import { formatDate } from "@/lib/dates";
import { AvailabilityBadge, DemoBadge, VerificationBadge } from "@/components/badges";
import { ImagePlaceholder, Num, Price, cx } from "@/components/ui";

export function AssetCard({
  asset,
  selected,
  hovered,
  onSelect,
}: {
  asset: MapAsset;
  selected?: boolean;
  /** The matching pin is under the cursor. Deliberately weaker than `selected`. */
  hovered?: boolean;
  onSelect?: (id: string) => void;
}) {
  const price = priceLine(asset);

  return (
    <article
      className={cx(
        "bg-white border rounded-lg overflow-hidden transition-colors",
        selected
          ? "border-brand-500 ring-1 ring-brand-500"
          : hovered
            ? "border-brand-300 bg-brand-50/50"
            : "border-ink-200 hover:border-ink-300"
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
            <Price
              amount={price.amount}
              per={price.per ?? undefined}
              from
              fallback={t("asset.priceNotPublished")}
            />
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
