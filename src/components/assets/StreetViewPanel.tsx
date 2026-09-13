import { t } from "@/lib/labels";
import { Card } from "@/components/ui";

/**
 * Google's own Street View of the listing's address, unaltered.
 *
 * This is the honest half of "how will it look at this address". The other
 * half - the advertiser's artwork on the sign - happens on a photograph the
 * owner supplied, never here. Google's terms forbid modifying Street View
 * imagery, and particularly modifications that misrepresent what the camera
 * captured; an ad painted onto their photo of a street is precisely that, and
 * the legal exposure would be the operator's.
 *
 * So: a separate panel, embedded rather than fetched and re-hosted, with the
 * attribution the embed carries. The Maps Embed API is free and unmetered,
 * which is also why this is an iframe and not the Static API - the static
 * endpoint returns an image file, and storing or re-serving one is what the
 * terms actually prohibit.
 *
 * Renders nothing without a key. A panel that says "Street View unavailable"
 * would be a dead promise, and this project does not ship those.
 */
export function StreetViewPanel({ latitude, longitude }: { latitude: number; longitude: number }) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY;
  if (!key) return null;

  const src =
    `https://www.google.com/maps/embed/v1/streetview` +
    `?key=${encodeURIComponent(key)}` +
    `&location=${latitude},${longitude}` +
    `&fov=90`;

  return (
    <Card className="p-4" data-streetview>
      <h2 className="font-medium text-ink-900">{t("street.title")}</h2>
      <p className="mt-1 text-sm text-ink-600">{t("street.note")}</p>
      <div className="mt-3 rounded-lg overflow-hidden border border-ink-200">
        <iframe
          title={t("street.title")}
          src={src}
          loading="lazy"
          // Street View has no coverage everywhere; the frame then shows
          // Google's own "no imagery here" state, which is the truth.
          referrerPolicy="no-referrer-when-downgrade"
          className="block w-full h-[320px] border-0"
          allowFullScreen
        />
      </div>
    </Card>
  );
}
