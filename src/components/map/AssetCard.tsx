"use client";

import Link from "next/link";
import type { MapAsset } from "@/server/assets";
import { t } from "@/lib/labels";
import { priceLine } from "@/lib/price";
import { formatDate } from "@/lib/dates";
import { AvailabilityBadge, VerificationBadge } from "@/components/badges";
import { ImagePlaceholder, Price, cx } from "@/components/ui";

/**
 * One result in the list beside the map.
 *
 * This is the component the density problem showed up in worst, because
 * whatever it costs is paid sixteen times over. It used to be a bordered,
 * shadowed box containing six rows - title, address, three badges, price - and
 * then a second bordered row underneath carrying a link that said "check
 * availability and price", which is what opening the listing does anyway. A
 * screenful of that is a wall, and none of the repeated parts told the reader
 * anything that distinguished one sign from the next.
 *
 * What survives is what actually differs between two listings: the
 * photograph, the name, where it is, and what it costs. Verification and
 * availability appear only when they are not the ordinary case (see
 * components/badges.tsx), and the demo marker moved out to a single line above
 * the list.
 *
 * Both behaviours the card had are kept, and it takes one fewer row to do it:
 *
 *   - Clicking the card selects its pin on the map. That is the full-bleed
 *     button underneath the content.
 *   - Clicking the title opens the listing. A link inside a button is not
 *     valid HTML and browsers disagree about what it even does, so the button
 *     is a sibling laid under the content rather than a wrapper around it.
 */
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
  const verification = asset.verificationStatus as "PENDING" | "VERIFIED";

  return (
    <article
      className={cx(
        "relative rounded-lg transition-colors",
        selected
          ? "bg-brand-50 ring-1 ring-brand-500"
          : hovered
            ? "bg-brand-50/50"
            : "hover:bg-ink-50"
      )}
    >
      {/* Under the content, covering the card. Carries the card's map
          behaviour without swallowing the link in the title. */}
      <button
        type="button"
        onClick={() => onSelect?.(asset.id)}
        className="absolute inset-0 w-full rounded-lg"
        aria-pressed={selected}
        aria-label={`${t("map.showOnMap")}: ${asset.title}`}
      />

      {/* pointer-events-none so the button below receives the click; the title
          link turns them back on for itself. */}
      <div className="relative pointer-events-none flex gap-3 p-3">
        <div className="size-20 shrink-0 rounded overflow-hidden">
          {asset.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={asset.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <ImagePlaceholder label={t("asset.noImages")} className="size-full" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm text-ink-900 line-clamp-2">
            <Link
              href={`/assets/${asset.id}`}
              data-open
              className="pointer-events-auto hover:underline"
            >
              {asset.title}
            </Link>
          </h3>
          <p className="text-xs text-ink-500 mt-0.5 truncate">
            {asset.city}
            {asset.address ? ` · ${asset.address}` : ""}
          </p>
          <p className="mt-1.5 text-sm font-medium text-ink-900">
            <Price
              amount={price.amount}
              per={price.per ?? undefined}
              from
              fallback={t("asset.priceNotPublished")}
            />
          </p>
          {/*
            Only the exceptions.

            "Available" and "verified" are what the great majority of listings
            on the map are, so printing them on every card is printing the same
            word sixteen times. What a reader needs to catch is the listing
            that is booked, or the one nobody has checked yet - so those, and
            only those, get a line of their own.
          */}
          {(asset.availability !== "AVAILABLE" || verification !== "VERIFIED") && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              {asset.availability !== "AVAILABLE" && (
                <AvailabilityBadge
                  state={asset.availability}
                  size="sm"
                  note={
                    asset.nextAvailable
                      ? `${t("common.from")}${formatDate(asset.nextAvailable)}`
                      : undefined
                  }
                />
              )}
              {verification !== "VERIFIED" && <VerificationBadge status={verification} size="sm" />}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
