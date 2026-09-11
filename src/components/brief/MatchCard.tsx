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
import { Card, Num, Price } from "@/components/ui";
import { AvailabilityBadge, DemoBadge, VerificationBadge } from "@/components/badges";
import type { Recommendation } from "@/server/brief";

export function MatchCard({ match }: { match: Recommendation }) {
  const a = match.asset;
  return (
    <Card className="p-4">
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
            <div className="flex flex-wrap gap-1.5">
              <AvailabilityBadge state={a.availability} />
              <VerificationBadge status={a.verificationStatus} />
              {a.isDemo && <DemoBadge />}
            </div>
          </div>

          <p className="text-sm text-ink-600 mt-0.5 truncate">
            {t(`type.${a.assetType}`)} · {a.city} · {a.address}
          </p>

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
        </div>
      </div>

      {match.reasons.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-ink-500">{t("brief.why")}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {match.reasons.map((reason) => (
              <li
                key={reason}
                className="rounded-full bg-ok-50 text-ok-700 border border-ok-500/30 px-2.5 py-1 text-xs"
              >
                {t(reason)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {match.gaps.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-ink-500">{t("brief.gaps")}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {match.gaps.map((gap) => (
              <li
                key={gap}
                className="rounded-full bg-ink-50 text-ink-600 border border-ink-200 px-2.5 py-1 text-xs"
              >
                {t(gap)}
              </li>
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
    </Card>
  );
}
