"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DEFAULT_MAP_CENTER, ISRAEL_BOUNDS } from "@/lib/constants";
import { t } from "@/lib/labels";
import { Num } from "@/components/ui";

/** Click the map to place the asset. The marker is also draggable. */
export function LocationPicker({
  latitude,
  longitude,
  onChange,
}: {
  latitude?: number;
  longitude?: number;
  onChange: (lat: number, lng: number) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(
    latitude != null && longitude != null ? { lat: latitude, lng: longitude } : null
  );

  useEffect(() => {
    if (!container.current || map.current) return;
    let cancelled = false;
    (async () => {
      const { mapStyle } = await import("@/lib/map-style");
      if (cancelled || !container.current) return;
      const m = new maplibregl.Map({
        container: container.current,
        style: mapStyle(),
        center: [longitude ?? DEFAULT_MAP_CENTER.lng, latitude ?? DEFAULT_MAP_CENTER.lat],
        zoom: latitude != null ? 15 : DEFAULT_MAP_CENTER.zoom,
        maxBounds: [
          [ISRAEL_BOUNDS.minLng - 2, ISRAEL_BOUNDS.minLat - 2],
          [ISRAEL_BOUNDS.maxLng + 2, ISRAEL_BOUNDS.maxLat + 2],
        ],
      });
      map.current = m;
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

      function place(lat: number, lng: number) {
        if (!marker.current) {
          marker.current = new maplibregl.Marker({ color: "#1f45d6", draggable: true })
            .setLngLat([lng, lat])
            .addTo(m);
          marker.current.on("dragend", () => {
            const pos = marker.current!.getLngLat();
            setPoint({ lat: pos.lat, lng: pos.lng });
            cb.current(pos.lat, pos.lng);
          });
        } else {
          marker.current.setLngLat([lng, lat]);
        }
        setPoint({ lat, lng });
        cb.current(lat, lng);
      }

      if (latitude != null && longitude != null) place(latitude, longitude);
      m.on("click", (e) => place(e.lngLat.lat, e.lngLat.lng));
    })();

    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-2">
      <div ref={container} className="h-72 rounded-md border border-ink-200 overflow-hidden" />
      <p className="text-xs text-ink-500">{t("wizard.pickOnMap")}</p>
      {point && (
        <p className="text-xs text-ink-600">
          <Num>{`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`}</Num>
        </p>
      )}
      <input type="hidden" name="latitude" value={point?.lat ?? ""} />
      <input type="hidden" name="longitude" value={point?.lng ?? ""} />
    </div>
  );
}
