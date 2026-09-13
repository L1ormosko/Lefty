import { Suspense } from "react";
import type { Metadata } from "next";
import { Discover } from "@/components/map/Discover";
import { citiesWithInventory, queryMapAssets, redactForRestricted } from "@/server/assets";
import { getCurrentUser } from "@/server/auth";
import { viewerAccess } from "@/server/subscription";
import { mapQuerySchema } from "@/lib/validation";
import { t } from "@/lib/labels";

export const metadata: Metadata = {
  title: "VELTO — מפת שטחי פרסום חוץ בישראל",
  description: t("app.tagline"),
};

export const dynamic = "force-dynamic";

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  );
  const parsed = mapQuerySchema.safeParse(flat);
  const query = parsed.success ? parsed.data : mapQuerySchema.parse({});

  // First paint is server-rendered: the map has inventory before any client fetch.
  const [rows, cities, viewer] = await Promise.all([
    queryMapAssets(query),
    citiesWithInventory(),
    viewerAccess(await getCurrentUser()),
  ]);
  // Redacted here too, not only in /api/assets. The first paint is HTML, and
  // an unredacted price in the server-rendered markup is just as readable as
  // one in a JSON response.
  const assets = viewer.full ? rows : rows.map(redactForRestricted);

  return (
    <main className="flex-1 flex flex-col min-h-0">
      <div className="h-12 lg:h-14 shrink-0 border-b border-ink-200 bg-white px-4 flex items-center gap-3 overflow-hidden">
        <h1 className="text-sm lg:text-base font-semibold text-ink-900 truncate">{t("home.headline")}</h1>
        <p className="hidden md:block text-sm text-ink-500 truncate">{t("home.sub")}</p>
      </div>
      <Suspense fallback={<div className="p-8 text-ink-500">{t("common.loading")}</div>}>
        <Discover initialAssets={assets} cities={cities} access={viewer} />
      </Suspense>
    </main>
  );
}
