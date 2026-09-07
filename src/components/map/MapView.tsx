"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapAsset } from "@/server/assets";
import { AVAILABILITY_COLORS, DEFAULT_MAP_CENTER, ISRAEL_BOUNDS } from "@/lib/constants";
import { t } from "@/lib/labels";

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
        availability: a.availability,
        color: AVAILABILITY_COLORS[a.availability],
      },
    })),
  };
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
      // GPU layer, so thousands of assets remain cheap.
      m.on("render", renderClusterLabels);

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
          const id = e.features?.[0]?.properties?.id as string | undefined;
          if (id) selectCb.current(id);
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
          if (hits.length === 0) selectCb.current(null);
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
