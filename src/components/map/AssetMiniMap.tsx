"use client";

import type { AvailabilityState } from "@/lib/constants";
import { MapView } from "./MapView";

/** Read-only single-marker map on the asset page. */
export function AssetMiniMap({
  latitude,
  longitude,
  availability,
}: {
  latitude: number;
  longitude: number;
  availability: AvailabilityState;
}) {
  return (
    <MapView
      assets={[
        {
          id: "self",
          title: "",
          city: "",
          address: "",
          assetType: "",
          isDigital: false,
          latitude,
          longitude,
          priceMonthly: null,
          priceWeekly: null,
          verificationStatus: "",
          isDemo: false,
          imageUrl: null,
          availability,
          nextAvailable: null,
        },
      ]}
      selectedId="self"
      onSelect={() => {}}
      interactive={false}
      initialView={{ lng: longitude, lat: latitude, zoom: 15 }}
    />
  );
}
