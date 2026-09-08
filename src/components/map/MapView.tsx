"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapAsset } from "@/server/assets";
import {
  AVAILABILITY_COLORS,
  CURRENCY,
  DEFAULT_MAP_CENTER,
  ISRAEL_BOUNDS,
  type AvailabilityState,
} from "@/lib/constants";
import { AVAILABILITY_GLYPH, t } from "@/lib/labels";

export type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

type Props = {
  assets: MapAsset[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onBoundsChange?: (b: Bounds) => void;
  initialView?: { lng: number; lat: number; zoom: number };
  interactive?: boolean;
  className?: string;
};

const SOURCE = "assets";

function toGeoJSON(assets: MapAsset[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: assets.map((a) => ({
      type: "Feature",
      id: a.id,
      geometry: { type: "Point", coordinates: [a.longitude, a.latitude] },
      properties: {
        id: a.id,
        title: a.title,
        city: a.city,
        assetType: a.assetType,
        availability: a.availability,
        priceMonthly: a.priceMonthly ?? null,
        priceWeekly: a.priceWeekly ?? null,
        verified: a.verificationStatus === "VERIFIED",
        color: AVAILABILITY_COLORS[a.availability],
      },
    })),
  };
}

/** Popup content is injected as HTML, and titles are owner-supplied text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function popupHtml(props: Record<string, unknown>): string {
  const title = escapeHtml(String(props.title ?? ""));
  const city = escapeHtml(String(props.city ?? ""));
  const id = encodeURIComponent(String(props.id ?? ""));
  const type = t(`type.${String(props.assetType)}`);
  const state = String(props.availability) as AvailabilityState;

  const monthly = props.priceMonthly as number | null;
  const weekly = props.priceWeekly as number | null;
  const price =
    monthly != null
      ? `${t("asset.priceFrom")}${CURRENCY}${monthly.toLocaleString("he-IL")} / חודש`
      : weekly != null
        ? `${t("asset.priceFrom")}${CURRENCY}${weekly.toLocaleString("he-IL")} / שבוע`
        : t("asset.priceNotPublished");

  const verified = props.verified
    ? `<span style="color:#1b37ad">✓ ${escapeHtml(t("verify.VERIFIED"))}</span>`
    : `<span style="color:#525e73">◷ ${escapeHtml(t("verify.PENDING"))}</span>`;

  return `
    <div dir="rtl" style="min-width:210px;padding:12px;font-family:inherit">
      <p style="margin:0;font-weight:600;font-size:14px;color:#191d26">${title}</p>
      <p style="margin:2px 0 0;font-size:12px;color:#67758c">${escapeHtml(type)} · ${city}</p>
      <p style="margin:8px 0 0;font-size:12px">
        <span style="color:${AVAILABILITY_COLORS[state]}">${escapeHtml(AVAILABILITY_GLYPH[state])} ${escapeHtml(t(`avail.${state}`))}</span>
        &nbsp;·&nbsp; ${verified}
      </p>
      <p style="margin:6px 0 0;font-size:13px;font-weight:500;color:#191d26" dir="ltr">${escapeHtml(price)}</p>
      <a href="/assets/${id}" style="display:inline-block;margin-top:10px;font-size:13px;color:#1f45d6;font-weight:500">
        ${escapeHtml(t("asset.requestAvailability"))} ←
      </a>
    </div>`;
}

export function MapView({
  assets,
  selectedId,
  onSelect,
  onBoundsChange,
  initialView = DEFAULT_MAP_CENTER,
  interactive = true,
  className,
}: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const clusterLabels = useRef(new Map<string, maplibregl.Marker>());
  const popup = useRef<maplibregl.Popup | null>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  const assetsRef = useRef(assets);
  const selectedRef = useRef(selectedId);
  const selectCb = useRef(onSelect);
  const boundsCb = useRef(onBoundsChange);
  assetsRef.current = assets;
  selectedRef.current = selectedId;
  selectCb.current = onSelect;
  boundsCb.current = onBoundsChange;

  function applyData() {
    const src = map.current?.getSource(SOURCE) as GeoJSONSource | undefined;
    src?.setData(toGeoJSON(assetsRef.current));
  }

  function applySelection() {
    const m = map.current;
    if (!m || !ready.current) return;
    m.removeFeatureState({ source: SOURCE });
    if (selectedRef.current) {
      m.setFeatureState({ source: SOURCE, id: selectedRef.current }, { selected: true });
    }
  }

  useEffect(() => {
    if (!container.current || map.current) return;
    let cancelled = false;

    function emitBounds() {
      const m = map.current;
      if (!m || !boundsCb.current) return;
      const b = m.getBounds();
      boundsCb.current({
        minLat: b.getSouth(),
        maxLat: b.getNorth(),
        minLng: b.getWest(),
        maxLng: b.getEast(),
      });
    }

    (async () => {
      const { mapStyle } = await import("@/lib/map-style");
      if (cancelled || !container.current) return;

      const m = new maplibregl.Map({
        container: container.current,
        style: mapStyle(),
        center: [initialView.lng, initialView.lat],
        zoom: initialView.zoom,
        maxBounds: [
          [ISRAEL_BOUNDS.minLng - 2, ISRAEL_BOUNDS.minLat - 2],
          [ISRAEL_BOUNDS.maxLng + 2, ISRAEL_BOUNDS.maxLat + 2],
        ],
        minZoom: 6,
        maxZoom: 18,
        interactive,
        attributionControl: { compact: true },
      });
      map.current = m;

      // Zoom buttons on pointer devices only: on touch, pinch-zoom is natural
      // and the buttons would collide with the floating search row.
      if (interactive && window.matchMedia("(min-width: 1024px)").matches) {
        // In an RTL page the "away from the content" corner is the left one.
        m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
      }

      // "Where am I" is the first thing a field buyer wants on a map of
      // physical sites. The browser still asks for permission; nothing is sent
      // anywhere - the position only moves the camera.
      if (interactive) {
        m.addControl(
          new maplibregl.GeolocateControl({
            positionOptions: { enableHighAccuracy: true },
            trackUserLocation: false,
            showAccuracyCircle: true,
          }),
          "top-left"
        );
      }

      // Keep the canvas in step with layout changes (sheet snap points,
      // orientation change, window resize).
      const ro = new ResizeObserver(() => m.resize());
      if (container.current) ro.observe(container.current);
      resizeObserver.current = ro;

      m.on("load", () => {
        m.addSource(SOURCE, {
          type: "geojson",
          data: toGeoJSON(assetsRef.current),
          cluster: true,
          clusterRadius: 48,
          clusterMaxZoom: 14,
        });

        m.addLayer({
          id: "clusters",
          type: "circle",
          source: SOURCE,
          filter: ["has", "point_count"],
          paint: {
            "circle-color": "#1f45d6",
            "circle-radius": ["step", ["get", "point_count"], 16, 10, 21, 40, 27],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
        m.addLayer({
          id: "points",
          type: "circle",
          source: SOURCE,
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": ["get", "color"],
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 11, 7],
            "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 4, 2],
            "circle-stroke-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              "#191d26",
              "#ffffff",
            ],
          },
        });

        ready.current = true;
        applySelection();
        renderClusterLabels();
        emitBounds();
      });

      // Cluster counts are drawn as DOM labels rather than a symbol layer,
      // because a symbol layer needs a glyph endpoint and the default style is
      // keyless. Only clusters get a DOM node - individual points stay on the
      // GPU layer, so thousands of assets remain cheap. Bound to "idle" rather
      // than "render": querySourceFeatures on every animation frame was the
      // single most expensive thing the map did while panning.
      m.on("idle", renderClusterLabels);
      // Markers stay anchored to their coordinate while panning, so panning
      // needs no help. Zooming re-clusters, which leaves counts attached to
      // circles that no longer exist - hide them until "idle" recomputes.
      m.on("zoomstart", hideClusterLabels);

      // Tiles can fail (offline, blocked network, provider outage). The markers
      // still work, so say so instead of showing an unexplained empty canvas.
      m.on("error", (e) => {
        const msg = String((e as { error?: Error }).error?.message ?? "");
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
          setTilesFailed(true);
        }
      });

      if (interactive) {
        m.on("click", "points", (e) => {
          const feature = e.features?.[0];
          const id = feature?.properties?.id as string | undefined;
          if (!feature || !id) return;
          selectCb.current(id);
          // A tap should answer "what is this?" on the map itself, without
          // making the user hunt for the matching card in the results list.
          popup.current?.remove();
          popup.current = new maplibregl.Popup({
            closeButton: true,
            maxWidth: "280px",
            offset: 14,
          })
            .setLngLat((feature.geometry as GeoJSON.Point).coordinates as [number, number])
            .setHTML(popupHtml(feature.properties as Record<string, unknown>))
            .addTo(m);
        });
        m.on("click", "clusters", async (e) => {
          const feature = e.features?.[0];
          if (!feature) return;
          const src = m.getSource(SOURCE) as GeoJSONSource;
          const zoom = await src.getClusterExpansionZoom(feature.properties.cluster_id as number);
          m.easeTo({
            center: (feature.geometry as GeoJSON.Point).coordinates as [number, number],
            zoom,
          });
        });
        m.on("click", (e) => {
          const hits = m.queryRenderedFeatures(e.point, { layers: ["points", "clusters"] });
          if (hits.length === 0) {
            popup.current?.remove();
            popup.current = null;
            selectCb.current(null);
          }
        });
        for (const layer of ["points", "clusters"]) {
          m.on("mouseenter", layer, () => {
            m.getCanvas().style.cursor = "pointer";
          });
          m.on("mouseleave", layer, () => {
            m.getCanvas().style.cursor = "";
          });
        }
        m.on("moveend", emitBounds);
      }
    })();

    function hideClusterLabels() {
      for (const marker of clusterLabels.current.values()) marker.remove();
      clusterLabels.current.clear();
    }

    function renderClusterLabels() {
      const m = map.current;
      if (!m || !ready.current || !m.isStyleLoaded()) return;
      const features = m.querySourceFeatures(SOURCE, { filter: ["has", "point_count"] });
      const seen = new Set<string>();
      for (const f of features) {
        const id = String(f.properties?.cluster_id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        let marker = clusterLabels.current.get(id);
        if (!marker) {
          const el = document.createElement("div");
          el.className =
            "pointer-events-none text-white text-xs font-semibold tabular-nums";
          el.style.transform = "translateY(1px)";
          marker = new maplibregl.Marker({ element: el }).setLngLat(coords).addTo(m);
          clusterLabels.current.set(id, marker);
        }
        marker.setLngLat(coords);
        marker.getElement().textContent = String(f.properties?.point_count ?? "");
      }
      for (const [id, marker] of clusterLabels.current) {
        if (!seen.has(id)) {
          marker.remove();
          clusterLabels.current.delete(id);
        }
      }
    }

    return () => {
      cancelled = true;
      resizeObserver.current?.disconnect();
      resizeObserver.current = null;
      for (const marker of clusterLabels.current.values()) marker.remove();
      clusterLabels.current.clear();
      popup.current?.remove();
      popup.current = null;
      map.current?.remove();
      map.current = null;
      ready.current = false;
    };
    // Mounts once; data and selection are pushed by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    applyData();
    applySelection();
  }, [assets]);

  // "View all Israel" and similar callers ask the map to move by event, so the
  // parent does not need a ref to the map instance.
  useEffect(() => {
    function onFly(e: Event) {
      const view = (e as CustomEvent<{ lng: number; lat: number; zoom: number }>).detail;
      map.current?.easeTo({ center: [view.lng, view.lat], zoom: view.zoom, duration: 600 });
    }
    window.addEventListener("velto:fly", onFly);
    return () => window.removeEventListener("velto:fly", onFly);
  }, []);

  useEffect(() => {
    applySelection();
    const m = map.current;
    if (!m || !selectedId) return;
    const asset = assets.find((a) => a.id === selectedId);
    if (asset) m.easeTo({ center: [asset.longitude, asset.latitude], duration: 400 });
  }, [selectedId, assets]);

  return (
    <>
      <div
        ref={container}
        className={className ?? "h-full w-full"}
        role="application"
        aria-label={t("map.title")}
      />
      {tilesFailed && (
        <p
          role="status"
          className="absolute bottom-2 inset-x-2 mx-auto w-fit rounded border border-ink-300 bg-white/95 px-2 py-1 text-[11px] text-ink-600 shadow-card"
        >
          {t("map.tilesUnavailable")}
        </p>
      )}
    </>
  );
}
