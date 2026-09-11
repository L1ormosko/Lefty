import type { Metadata } from "next";
import Link from "next/link";
import { t } from "@/lib/labels";
import { ASSET_TYPES, LOCATION_TAGS, CURRENCY } from "@/lib/constants";
import { briefQuerySchema } from "@/lib/validation";
import { EMPTY_BRIEF, applyExplicit, isEmptyBrief, type Brief } from "@/lib/brief";
import { citiesWithInventory } from "@/server/assets";
import { parseBriefText, aiEnabled } from "@/server/ai";
import { runBrief } from "@/server/brief";
import { freeingSoon } from "@/server/expiring";
import { todayUtc, formatDate } from "@/lib/dates";
import { Card, Num } from "@/components/ui";
import { Section } from "@/components/DashboardShell";
import { BriefForm } from "@/components/brief/BriefForm";
import { MatchCard } from "@/components/brief/MatchCard";

export const metadata: Metadata = {
  title: "VELTO — התאמת שטחי פרסום לקמפיין",
  description: "תיאור קמפיין אחד, ורשימה מדורגת מתוך המלאי שקיים במערכת.",
};

export const dynamic = "force-dynamic";

/** A repeated checkbox group arrives as a repeated key; keep only known values. */
function pickList(raw: Record<string, string | string[] | undefined>, key: string, allowed: readonly string[]) {
  const value = raw[key];
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.filter((v) => allowed.includes(v));
}

export default async function BriefPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  );
  const parsedQuery = briefQuerySchema.safeParse(flat);
  const query = parsedQuery.success ? parsedQuery.data : {};

  const cities = await citiesWithInventory();
  const cityNames = cities.map((c) => c.city);
  const text = query.text ?? "";

  // Free text first, then anything the advertiser set by hand on top of it.
  const { brief: fromText, source } = await parseBriefText(text, {
    knownCities: cityNames,
    today: todayUtc(),
  });

  const brief: Brief = applyExplicit(fromText, {
    cities: pickList(raw, "cities", cityNames),
    assetTypes: pickList(raw, "types", ASSET_TYPES) as Brief["assetTypes"],
    locationTags: pickList(raw, "tags", LOCATION_TAGS) as Brief["locationTags"],
    startDate: query.startDate || null,
    endDate: query.endDate || null,
    budget: typeof query.budget === "number" ? query.budget : null,
    digitalOnly: query.digitalOnly === "1",
    verifiedOnly: query.verifiedOnly === "1",
  });

  const asked = !isEmptyBrief(brief);
  const [matches, freeing] = await Promise.all([
    asked ? runBrief(brief) : Promise.resolve([]),
    freeingSoon(),
  ]);

  return (
    <main className="mx-auto w-full max-w-[1100px] px-4 py-6 flex-1">
      <h1 className="text-xl font-semibold text-ink-900">{t("brief.title")}</h1>
      <p className="mt-1 text-sm text-ink-600 max-w-2xl">{t("brief.lead")}</p>

      <div className="mt-5">
        <BriefForm brief={brief} text={text} cities={cities} />
        <p className="mt-2 text-xs text-ink-500">
          {aiEnabled() && source === "model" ? t("brief.aiOn") : t("brief.aiOff")}
        </p>
      </div>

      <div className="mt-6">
        {cities.length === 0 ? (
          <Card className="p-4 text-sm text-ink-600">{t("brief.noInventory")}</Card>
        ) : !asked ? (
          <Card className="p-4 text-sm text-ink-600">{t("brief.askFirst")}</Card>
        ) : matches.length === 0 ? (
          <Card className="p-4 text-sm text-ink-600">{t("brief.empty")}</Card>
        ) : (
          <Section
            title={t("brief.results")}
            action={
              <span className="text-sm text-ink-500">
                <Num>{matches.length}</Num> {t("brief.resultsCount")}
              </span>
            }
          >
            <div className="space-y-3">
              {matches.map((match) => (
                <MatchCard key={match.assetId} match={match} />
              ))}
            </div>
          </Section>
        )}
      </div>

      {/*
        The one thing an advertiser cannot find out anywhere else: which
        billboards are about to come free. Derived from approved bookings, so
        it is a fact rather than a forecast - what we do NOT claim is whether
        the current advertiser will renew.
      */}
      {freeing.length > 0 && (
        <Section title={t("expiring.freeingTitle")}>
          <p className="-mt-2 mb-3 text-sm text-ink-600">{t("expiring.freeingLead")}</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {freeing.map((item) => (
              <Card key={item.assetId} className="p-3">
                <Link href={`/assets/${item.assetId}`} className="font-medium text-ink-900 hover:underline">
                  {item.title}
                </Link>
                <p className="text-sm text-ink-600 mt-0.5">
                  {t(`type.${item.assetType}`)} · {item.city}
                </p>
                <p className="mt-2 text-sm text-ink-700">
                  {t("expiring.freesOn")} <Num>{formatDate(item.freesOn)}</Num>
                  <span className="text-ink-500">
                    {" "}
                    (<Num>{item.daysLeft}</Num> {t("expiring.daysLeft")})
                  </span>
                </p>
              </Card>
            ))}
          </div>
        </Section>
      )}

      <Card className="mt-6 p-4">
        <h2 className="text-sm font-semibold text-ink-900">{t("brief.howItWorks")}</h2>
        <p className="mt-1 text-sm text-ink-600">{t("brief.honesty")}</p>
        <p className="mt-2 text-xs text-ink-500">
          {CURRENCY} — {t("asset.priceEstimateNote")}
        </p>
      </Card>
    </main>
  );
}
