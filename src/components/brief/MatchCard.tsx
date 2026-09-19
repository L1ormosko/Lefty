/**
 * One recommendation.
 *
 * The card's job is to be honest twice over: it says why the asset is on the
 * list, and it says what the list could not take into account. The second half
 * matters more than the first - a shortlist that only shows its strengths is
 * how an advertiser ends up on the phone discovering that nobody published a
 * price.
 */
import Link from "next/link";
import { t } from "@/lib/labels";
import { formatDate } from "@/lib/dates";
import { Num, Price } from "@/components/ui";
import { AvailabilityBadge, VerificationBadge } from "@/components/badges";
import type { Recommendation } from "@/server/brief";

/**
 * A chip carrying one reason or one gap.
 *
 * Filled, not outlined. A short label already reads as a unit against a tinted
 * background; drawing a border round it as well doubles the number of lines on
 * a card that can carry a dozen of these, and the colour is doing the work
 * either way. The glyph keeps the two kinds apart without relying on it.
 */
function Chip({ kind, children }: { kind: "reason" | "gap"; children: React.ReactNode }) {
  return (
    <li
      className={
        kind === "reason"
          ? "rounded-full bg-ok-50 text-ok-700 px-2.5 py-1 text-xs"
          : "rounded-full bg-ink-100 text-ink-600 px-2.5 py-1 text-xs"
      }
    >
      {children}
    </li>
  );
}

export function MatchCard({ match }: { match: Recommendation }) {
  const a = match.asset;
  return (
    <div className="p-4">
      <div className="flex gap-3">
        {a.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={a.imageUrl}
            alt=""
            className="h-20 w-28 shrink-0 rounded-md object-cover bg-ink-100"
            loading="lazy"
          />
        ) : (
          <div className="h-20 w-28 shrink-0 rounded-md bg-ink-100" aria-hidden />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-2">
            <Link href={`/assets/${a.id}`} className="font-medium text-ink-900 hover:underline">
              {a.title}
            </Link>
            {/* Only the exceptions, the same rule the map's result card
                follows: "available" and "verified" are what most of the
                inventory is, and a marker printed on every row distinguishes
                nothing. The demo marker moved to one line above the list. */}
            {(a.availability !== "AVAILABLE" || a.verificationStatus !== "VERIFIED") && (
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                {a.availability !== "AVAILABLE" && <AvailabilityBadge state={a.availability} />}
                {a.verificationStatus !== "VERIFIED" && (
                  <VerificationBadge status={a.verificationStatus} />
                )}
              </div>
            )}
          </div>

          <p className="text-sm text-ink-600 mt-0.5 truncate">
            {t(`type.${a.assetType}`)} · {a.city}
            {a.address ? ` · ${a.address}` : ""}
          </p>

          {/* A viewer without access is told the fields are withheld, not shown
              an empty price that reads as "this one has no price". */}
          {a.restricted ? (
            <p className="mt-2 text-sm text-ink-500">{t("access.hiddenOnCard")}</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-ink-700">
                <span className="text-ink-500 text-xs">{t("brief.priceForWindow")}: </span>
                <Price amount={a.priceEstimate} />
              </span>
              {a.availability !== "AVAILABLE" && a.nextAvailable && (
                <span className="text-ink-700">
                  <span className="text-ink-500 text-xs">{t("expiring.freesOn")} </span>
                  <Num>{formatDate(a.nextAvailable)}</Num>
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {match.reasons.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-ink-500">{t("brief.why")}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {match.reasons.map((reason) => (
              <Chip key={reason} kind="reason">
                {t(reason)}
              </Chip>
            ))}
          </ul>
        </div>
      )}

      {match.gaps.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-ink-500">{t("brief.gaps")}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {match.gaps.map((gap) => (
              <Chip key={gap} kind="gap">
                {t(gap)}
              </Chip>
            ))}
          </ul>
        </div>
      )}

      {a.locationTags.length > 0 && (
        <p className="mt-3 text-xs text-ink-500">
          {a.locationTags.map((tag) => t(`tag.${tag}`)).join(" · ")}
          <span className="text-ink-400"> — {t("tag.declared")}</span>
        </p>
      )}
    </div>
  );
}
