"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { MapAsset } from "@/server/assets";
import { DEFAULT_MAP_CENTER, ISRAEL_VIEW } from "@/lib/constants";
import { t } from "@/lib/labels";
import { Button, EmptyState, Num, cx, inputClass } from "@/components/ui";
import { MapView, type Bounds, type Viewport } from "./MapView";
import { FilterPanel } from "./FilterPanel";
import { AssetCard } from "./AssetCard";
import { FilterChips, chipText } from "./FilterChips";
import { clampFraction, nextSheet, snapTo, type Sheet } from "./sheet";
import {
  EMPTY_FILTERS,
  describeFilters,
  filtersFromParams,
  filtersToParams,
  suggestRelaxation,
  type Filters,
} from "./filters";

type Props = {
  initialAssets: MapAsset[];
  cities: { city: string; count: number }[];
};

export function Discover({ initialAssets, cities }: Props) {
  const searchParams = useSearchParams();
  // Never hardcode the route here: this component renders at /explore, and
  // writing filters back to "/" navigated the user off the map onto the
  // marketing page every time they touched a filter.
  const pathname = usePathname();

  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(new URLSearchParams(searchParams)));
  const [assets, setAssets] = useState<MapAsset[]>(initialAssets);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which asset the pointer (or keyboard focus) is on, in either direction.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>("collapsed");
  // Live height while a finger is on the handle; null the rest of the time,
  // when the sheet sits on one of its three resting heights.
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    startY: number;
    startHeight: number;
    height: number;
    lastY: number;
    lastTime: number;
    velocity: number;
    moved: boolean;
  } | null>(null);
  const draggedRef = useRef(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState(filters.q);
  const bounds = useRef<Bounds | null>(null);
  const view = useRef<Viewport | null>(null);

  // Where the map opens. Read once, from the URL, because the map mounts once:
  // a shared link has to land on the same view its sender was looking at, and
  // after that the camera belongs to the user, not to the query string.
  const [initialView] = useState(() => {
    const p = new URLSearchParams(searchParams);
    const lat = Number(p.get("lat"));
    const lng = Number(p.get("lng"));
    const zoom = Number(p.get("z"));
    const ok = [lat, lng, zoom].every((n) => Number.isFinite(n)) && p.has("lat") && p.has("lng") && p.has("z");
    return ok ? { lat, lng, zoom } : DEFAULT_MAP_CENTER;
  });
  const firstRun = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  const panTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAssets = useCallback(async (next: Filters) => {
    // Panning fires these back to back. Without cancellation a slow early
    // response can land after a newer one and repopulate the map with assets
    // for a viewport the user already left.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

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
      const res = await fetch(`/api/assets?${params.toString()}`, { signal: controller.signal });
      if (!res.ok) throw new Error("request failed");
      const data = (await res.json()) as { assets: MapAsset[] };
      setAssets(data.assets);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(t("common.error"));
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, []);

  /**
   * The whole URL, filters and camera together.
   *
   * One function because there is one query string: when the filter effect and
   * the pan handler each wrote their own half, whichever fired second dropped
   * the other's parameters.
   */
  const urlFor = useCallback(
    (f: Filters) => {
      const p = filtersToParams(f);
      const v = view.current;
      if (v) {
        // Four decimals is about ten metres - enough to come back to the same
        // street corner, short enough to leave the URL readable.
        p.set("z", v.zoom.toFixed(2));
        p.set("lat", v.lat.toFixed(4));
        p.set("lng", v.lng.toFixed(4));
      }
      const qs = p.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname]
  );

  /**
   * Write the URL without navigating.
   *
   * `router.replace` was doing this, and it is a route navigation: a card
   * clicked through to /assets/x lost the navigation to a replace that fired
   * from the pan timer milliseconds later, landing the user back on the map.
   * Nothing here needs the router - the results come from /api/assets and the
   * URL exists so the search can be shared and reopened.
   */
  const writeUrl = useCallback(
    (f: Filters) => {
      // Only ever rewrite *this* page's URL. Clicking a card through to
      // /assets/x resizes the map container on its way out, MapLibre answers a
      // resize with a moveend, and the camera write that followed replaced the
      // brand-new /assets/x URL with the map's - bouncing the user straight
      // back. The navigation has already happened by then, so the pathname is
      // the tell.
      if (window.location.pathname !== pathname) return;
      const next = urlFor(f);
      if (next === window.location.pathname + window.location.search) return;
      window.history.replaceState(null, "", next);
    },
    [pathname, urlFor]
  );

  // Debounced refetch + URL sync whenever the filters change.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const id = setTimeout(() => {
      writeUrl(filters);
      void fetchAssets(filters);
    }, 350);
    return () => clearTimeout(id);
  }, [filters, fetchAssets, writeUrl]);

  // The pan timer outlives this component unless it is cancelled: click a card
  // through to /assets/x within 300ms of the map settling and the timer fires
  // after the navigation, replacing the URL with /explore and pulling the user
  // straight back to the map. Harmless while it only refetched; not harmless
  // now that it writes the URL.
  useEffect(() => {
    return () => {
      if (panTimer.current) clearTimeout(panTimer.current);
      inFlight.current?.abort();
    };
  }, []);

  const patch = useCallback((p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p })), []);
  const reset = useCallback(() => {
    setSearch("");
    setFilters(EMPTY_FILTERS);
  }, []);

  // The search box holds `q` in its own state so typing stays responsive, so a
  // patch that clears `q` has to clear the box too - otherwise the chip
  // vanishes and the text is still sitting there, apparently still in effect.
  const clearFilter = useCallback(
    (p: Partial<Filters>) => {
      if ("q" in p) setSearch(p.q ?? "");
      patch(p);
    },
    [patch]
  );

  const onBoundsChange = useCallback(
    (b: Bounds, v: Viewport) => {
      const first = bounds.current == null;
      bounds.current = b;
      view.current = v;
      if (first) return;
      // The URL is written here and now, not from the timer below. moveend
      // already fires once per gesture - after inertia finishes - so there is
      // nothing to debounce, and a deferred write is a write that can land
      // after the user has clicked a card through to /assets/x, where it
      // cancels their navigation and drops them back on the map.
      writeUrl(filters);
      // The refetch stays debounced: that one is a request, and a flicked map
      // emits enough moveends to be worth collapsing.
      if (panTimer.current) clearTimeout(panTimer.current);
      panTimer.current = setTimeout(() => void fetchAssets(filters), 300);
    },
    [fetchAssets, filters, writeUrl]
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

  const chips = useMemo(() => describeFilters(filters), [filters]);
  const activeCount = chips.length;
  // Which single filter to offer dropping when nothing matched. Deliberately
  // one, not a list: the point is the smallest step back into results.
  const relax = useMemo(() => suggestRelaxation(filters), [filters]);

  // Resting heights as classes rather than inline style, so the sheet has its
  // height on the server's first paint instead of collapsing to its content
  // and jumping. These three must agree with snapPoints() in sheet.ts, which
  // is what the drag snaps against.
  const sheetHeight = { collapsed: "h-[92px]", half: "h-[52dvh]", full: "h-[88dvh]" }[sheet];

  /* ---------------------------------------------------------------- *
   * Dragging the sheet
   * ---------------------------------------------------------------- */

  const viewportHeight = useCallback(
    () => sheetRef.current?.parentElement?.clientHeight || window.innerHeight,
    []
  );

  const startDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const height = sheetRef.current?.getBoundingClientRect().height ?? 0;
    drag.current = {
      startY: e.clientY,
      startHeight: height,
      height,
      lastY: e.clientY,
      lastTime: e.timeStamp,
      velocity: 0,
      moved: false,
    };
    // Capture, so a fast drag that leaves the handle still reaches us.
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const moveDrag = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d) return;
      const viewport = viewportHeight();
      // Up is positive: the sheet grows upward from the bottom of the screen.
      const travelled = d.startY - e.clientY;
      // A few pixels of slop, so a tap with an unsteady thumb is still a tap.
      if (Math.abs(travelled) > 4) d.moved = true;

      const elapsed = (e.timeStamp - d.lastTime) / 1000;
      if (elapsed > 0) d.velocity = (d.lastY - e.clientY) / viewport / elapsed;
      d.lastY = e.clientY;
      d.lastTime = e.timeStamp;

      d.height = clampFraction((d.startHeight + travelled) / viewport, viewport) * viewport;
      setDragHeight(d.height);
    },
    [viewportHeight]
  );

  const endDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    setDragHeight(null);
    if (!d) return;
    if (!d.moved) return; // A tap; the click handler answers it.
    // Suppress the click that follows the release, or the sheet would snap and
    // then immediately cycle to the next height.
    draggedRef.current = true;
    const viewport = viewportHeight();
    setSheet(snapTo(d.height / viewport, d.velocity, viewport));
  }, [viewportHeight]);

  const resultsList = (surface: "desktop" | "mobile") => (
    <div data-results={surface} className="space-y-2 p-3">
      <FilterChips chips={chips} onClear={clearFilter} onClearAll={reset} className="pb-1" />

      {assets.length === 0 && !loading ? (
        activeCount > 0 ? (
          // Nothing matched *the filters* - a different situation from an empty
          // area, and it gets a way out that is one step rather than all of them.
          <EmptyState
            title={t("map.noMatchTitle")}
            hint={t("map.noMatchHint")}
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {relax && (
                  <Button size="sm" onClick={() => clearFilter(relax.clear)}>
                    {t("map.relaxFilter", { filter: chipText(relax) })}
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={reset}>
                  {t("map.clearFilters")}
                </Button>
              </div>
            }
          />
        ) : (
          <EmptyState title={t("map.noResults")} hint={t("map.noResultsHint")} />
        )
      ) : (
        assets.map((a) => (
          <div
            key={a.id}
            data-asset={a.id}
            // Focus as well as hover: tabbing through the results is a first
            // path, not a consolation, and it should light the same pin.
            // Deliberately no scrollIntoView here - the list moving under a
            // passing cursor is the thing that makes linked lists unusable.
            //
            // Pointer events rather than mouse events, and only for a real
            // mouse: a tap on a touch screen emits a compatibility mouseenter
            // that is never followed by a mouseleave, so the tapped card kept
            // a highlight that nothing could clear.
            onPointerEnter={(e) => e.pointerType === "mouse" && setHoveredId(a.id)}
            onPointerLeave={(e) =>
              e.pointerType === "mouse" && setHoveredId((id) => (id === a.id ? null : id))
            }
            onFocus={() => setHoveredId(a.id)}
            onBlur={() => setHoveredId((id) => (id === a.id ? null : id))}
          >
            <AssetCard
              asset={a}
              selected={a.id === selectedId}
              hovered={a.id === hoveredId}
              onSelect={selectAsset}
            />
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
      {/* Both rails are fluid: fixed 320+380 left a 1280px laptop with barely
          half the width for the map, which is the product. */}
      <aside className="hidden lg:flex w-[clamp(260px,20vw,340px)] shrink-0 border-e border-ink-200 bg-white flex-col">
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
            hoveredId={hoveredId}
            onHover={setHoveredId}
            onBoundsChange={onBoundsChange}
            initialView={initialView}
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
              <div role="alert" className="bg-bad-50 border border-bad-200 text-bad-700 text-sm rounded-md px-3 py-2 shadow-card">
                {error}
              </div>
            </div>
          )}

          {/* Mobile: floating search + filter button, then a compact context row */}
          {/* The trailing padding is a lane for the map's own controls: the
              geolocate button sits in the top-left corner, which in an RTL
              layout is exactly where a full-width row ends - the filter button
              and its count badge were sitting underneath it. */}
          <div className="lg:hidden absolute top-3 inset-x-3 pe-11 flex flex-col gap-2">
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
        <div className="hidden lg:block w-[clamp(320px,26vw,420px)] shrink-0 border-s border-ink-200 bg-ink-50 overflow-y-auto">
          {resultsList("desktop")}
        </div>

        {/* Mobile bottom sheet */}
        <div
          ref={sheetRef}
          className={cx(
            "lg:hidden absolute inset-x-0 bottom-0 bg-white rounded-t-2xl shadow-panel border-t border-ink-200 flex flex-col",
            // No transition mid-drag: the sheet has to sit under the finger,
            // and a 200ms ease turns a drag into a rubber band.
            dragHeight == null && "transition-[height] duration-200",
            dragHeight == null && sheetHeight
          )}
          style={dragHeight == null ? undefined : { height: `${dragHeight}px` }}
        >
          <button
            type="button"
            className="pt-2 pb-1 flex flex-col items-center gap-1 shrink-0 touch-none"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            // Keyboard and assistive tech reach the sheet through the same
            // control: a drag is not a thing you can do with a keyboard, so
            // tapping must always remain a way to open it.
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              setSheet(nextSheet(sheet));
            }}
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
