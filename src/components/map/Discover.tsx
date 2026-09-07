"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MapAsset } from "@/server/assets";
import { DEFAULT_MAP_CENTER, ISRAEL_VIEW } from "@/lib/constants";
import { t } from "@/lib/labels";
import { Button, EmptyState, Num, cx, inputClass } from "@/components/ui";
import { MapView, type Bounds } from "./MapView";
import { FilterPanel } from "./FilterPanel";
import { AssetCard } from "./AssetCard";
import { EMPTY_FILTERS, activeFilterCount, filtersFromParams, filtersToParams, type Filters } from "./filters";

type Props = {
  initialAssets: MapAsset[];
  cities: { city: string; count: number }[];
};

type Sheet = "collapsed" | "half" | "full";

export function Discover({ initialAssets, cities }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(new URLSearchParams(searchParams)));
  const [assets, setAssets] = useState<MapAsset[]>(initialAssets);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>("collapsed");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState(filters.q);
  const bounds = useRef<Bounds | null>(null);
  const firstRun = useRef(true);

  const fetchAssets = useCallback(
    async (next: Filters) => {
      setLoading(true);
      setError(null);
      try {
        const params = filtersToParams(next);
        // Bounding box keeps the payload small: only what the viewport shows.
        if (bounds.current && !next.city) {
          params.set("minLat", String(bounds.current.minLat));
          params.set("maxLat", String(bounds.current.maxLat));
          params.set("minLng", String(bounds.current.minLng));
          params.set("maxLng", String(bounds.current.maxLng));
        }
        const res = await fetch(`/api/assets?${params.toString()}`);
        if (!res.ok) throw new Error("request failed");
        const data = (await res.json()) as { assets: MapAsset[] };
        setAssets(data.assets);
      } catch {
        setError(t("common.error"));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Debounced refetch + URL sync whenever the filters change.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const id = setTimeout(() => {
      const qs = filtersToParams(filters).toString();
      router.replace(qs ? `/?${qs}` : "/", { scroll: false });
      void fetchAssets(filters);
    }, 350);
    return () => clearTimeout(id);
  }, [filters, fetchAssets, router]);

  const patch = useCallback((p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p })), []);
  const reset = useCallback(() => {
    setSearch("");
    setFilters(EMPTY_FILTERS);
  }, []);

  const onBoundsChange = useCallback(
    (b: Bounds) => {
      const first = bounds.current == null;
      bounds.current = b;
      if (!first) void fetchAssets(filters);
    },
    [fetchAssets, filters]
  );

  const selectAsset = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) {
      setSheet((s) => (s === "collapsed" ? "half" : s));
      requestAnimationFrame(() => {
        for (const card of document.querySelectorAll(`[data-asset="${id}"]`)) {
          if ((card as HTMLElement).offsetParent !== null) {
            card.scrollIntoView({ block: "nearest", behavior: "smooth" });
            break;
          }
        }
      });
    }
  }, []);

  const activeCount = useMemo(() => activeFilterCount(filters), [filters]);

  const sheetHeight = { collapsed: "h-[92px]", half: "h-[52dvh]", full: "h-[88dvh]" }[sheet];

  const resultsList = (surface: "desktop" | "mobile") => (
    <div data-results={surface} className="space-y-2 p-3">
      {assets.length === 0 && !loading ? (
        <EmptyState
          title={t("map.noResults")}
          hint={t("map.noResultsHint")}
          action={
            activeCount > 0 ? (
              <Button variant="secondary" size="sm" onClick={reset}>
                {t("map.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        assets.map((a) => (
          <div key={a.id} data-asset={a.id}>
            <AssetCard asset={a} selected={a.id === selectedId} onSelect={selectAsset} />
          </div>
        ))
      )}
    </div>
  );

  return (
    // The map shell owns the viewport below the 56px header, so the map canvas
    // has a real height instead of collapsing in a flex chain.
    <div className="flex flex-col lg:flex-row h-[calc(100dvh_-_6.5rem)] lg:h-[calc(100dvh_-_7rem)] min-h-0">
      {/* Desktop filter rail */}
      <aside className="hidden lg:flex w-[320px] shrink-0 border-e border-ink-200 bg-white flex-col">
        <div className="p-4 border-b border-ink-200">
          <label htmlFor="search" className="sr-only">
            {t("map.searchPlaceholder")}
          </label>
          <input
            id="search"
            className={inputClass}
            placeholder={t("map.searchPlaceholder")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              patch({ q: e.target.value });
            }}
          />
        </div>
        <FilterPanel
          filters={filters}
          cities={cities}
          onChange={patch}
          onReset={reset}
          resultCount={assets.length}
          className="flex-1 min-h-0"
        />
      </aside>

      {/* Map + results */}
      <div className="relative flex-1 min-h-0 flex">
        <div className="relative flex-1">
          <MapView
            assets={assets}
            selectedId={selectedId}
            onSelect={selectAsset}
            onBoundsChange={onBoundsChange}
            initialView={DEFAULT_MAP_CENTER}
          />

          {/* Context strip: what the map is showing right now. */}
          <div className="hidden lg:flex absolute top-3 start-3 items-center gap-2 pointer-events-none">
            <div className="pointer-events-auto bg-white/95 backdrop-blur border border-ink-200 rounded-md shadow-card px-3 py-2 text-sm">
              {loading ? (
                <span className="text-ink-500">{t("common.loading")}</span>
              ) : (
                <span className="text-ink-800 font-medium">
                  {t("map.resultsCount", { count: assets.length })}
                </span>
              )}
              <span className="block text-[11px] text-ink-500">{t("map.inventoryNote")}</span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="pointer-events-auto shadow-card"
              onClick={() => {
                bounds.current = null;
                setSelectedId(null);
                window.dispatchEvent(new CustomEvent("velto:fly", { detail: ISRAEL_VIEW }));
              }}
            >
              {t("map.viewAllIsrael")}
            </Button>
          </div>

          {error && (
            <div className="absolute bottom-24 lg:bottom-4 inset-x-4 lg:inset-x-auto lg:start-4 z-10">
              <div role="alert" className="bg-bad-50 border border-bad-500/30 text-bad-700 text-sm rounded-md px-3 py-2 shadow-card">
                {error}
              </div>
            </div>
          )}

          {/* Mobile: floating search + filter button, then a compact context row */}
          <div className="lg:hidden absolute top-3 inset-x-3 flex flex-col gap-2">
            <div className="flex gap-2">
            <input
              aria-label={t("map.searchPlaceholder")}
              className={cx(inputClass, "min-w-0 flex-1 shadow-card bg-white/95 backdrop-blur")}
              placeholder={t("map.searchPlaceholder")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                patch({ q: e.target.value });
              }}
            />
            <Button
              variant="secondary"
              className="shrink-0 whitespace-nowrap shadow-card"
              onClick={() => setFiltersOpen(true)}
              aria-haspopup="dialog"
            >
              {t("map.filters")}
              {activeCount > 0 && (
                <span className="ms-1 inline-flex items-center justify-center size-5 rounded-full bg-brand-600 text-white text-[11px]">
                  <Num>{activeCount}</Num>
                </span>
              )}
            </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="shadow-card"
                onClick={() => {
                  bounds.current = null;
                  setSelectedId(null);
                  window.dispatchEvent(new CustomEvent("velto:fly", { detail: ISRAEL_VIEW }));
                }}
              >
                {t("map.viewAllIsrael")}
              </Button>
              {loading && (
                <span className="text-xs text-ink-600 bg-white/95 rounded px-2 py-1 shadow-card">
                  {t("common.loading")}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Desktop results column */}
        <div className="hidden lg:block w-[380px] shrink-0 border-s border-ink-200 bg-ink-50 overflow-y-auto">
          {resultsList("desktop")}
        </div>

        {/* Mobile bottom sheet */}
        <div
          className={cx(
            "lg:hidden absolute inset-x-0 bottom-0 bg-white rounded-t-2xl shadow-panel border-t border-ink-200 flex flex-col transition-[height] duration-200",
            sheetHeight
          )}
        >
          <button
            type="button"
            className="pt-2 pb-1 flex flex-col items-center gap-1 shrink-0"
            onClick={() => setSheet(sheet === "collapsed" ? "half" : sheet === "half" ? "full" : "collapsed")}
            aria-label={t("map.list")}
            aria-expanded={sheet !== "collapsed"}
          >
            <span className="h-1 w-10 rounded-full bg-ink-300" aria-hidden="true" />
            <span className="text-sm font-medium text-ink-800">
              {t("map.resultsCount", { count: assets.length })}
            </span>
          </button>
          <div className={cx("flex-1 overflow-y-auto", sheet === "collapsed" && "hidden")}>
            {resultsList("mobile")}
          </div>
        </div>

        {/* Mobile filters: full-screen dialog, not a nested sheet */}
        {filtersOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("map.filters")}
            className="lg:hidden fixed inset-0 z-40 bg-white flex flex-col"
          >
            <div className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-ink-200">
              <h2 className="font-medium text-ink-900">{t("map.filters")}</h2>
              <Button variant="ghost" size="sm" onClick={() => setFiltersOpen(false)}>
                {t("common.close")}
              </Button>
            </div>
            <FilterPanel
              filters={filters}
              cities={cities}
              onChange={patch}
              onReset={reset}
              resultCount={assets.length}
              onApply={() => setFiltersOpen(false)}
              className="flex-1 min-h-0"
            />
          </div>
        )}
      </div>
    </div>
  );
}
