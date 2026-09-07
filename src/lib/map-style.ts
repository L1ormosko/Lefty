import type { StyleSpecification } from "maplibre-gl";

/**
 * Map tiles.
 *
 * Default is a keyless raster style served by the OpenStreetMap community
 * tile servers, which render Hebrew place names in Israel. It is suitable for
 * development and low traffic only - OSM's tile usage policy forbids heavy
 * production use. For production set NEXT_PUBLIC_MAP_STYLE_URL to a commercial
 * vector style (MapTiler, Mapbox, Amazon Location...) whose key lives in the
 * environment, never in the source.
 */
export const CUSTOM_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "";

export const OSM_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#eceef2" } },
    {
      id: "osm",
      type: "raster",
      source: "osm",
      paint: { "raster-saturation": -0.25, "raster-contrast": -0.05 },
    },
  ],
};

export function mapStyle(): string | StyleSpecification {
  return CUSTOM_STYLE_URL || OSM_RASTER_STYLE;
}
