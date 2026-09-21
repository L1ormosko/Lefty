import { t } from "@/lib/labels";
import { Card } from "@/components/ui";
import { lookupPano, embedViewUrl } from "@/server/streetview";

/**
 * Google's own view of the address, pointed at the sign.
 *
 * It used to be pointed at nothing in particular. The embed was given the
 * listing's coordinates and no more, so Google picked the nearest panorama
 * and faced the camera in whatever direction that panorama's car had been
 * travelling. On a corner plot that is the other street: the panel said "this
 * is the site" and showed somewhere else, which is worse than showing nothing.
 *
 * Now the panorama is looked up first (server/streetview.ts) and the frame is
 * pinned to its id, with a heading computed from where the camera actually
 * stands towards where the sign actually is. The panel also says how far away
 * the camera is and when Google took the picture, because both change how much
 * the viewer should trust what they are looking at - a view from 60m in 2019
 * is a different kind of evidence from one from 8m last year.
 *
 * Nothing is drawn on top of this. The creative preview happens in its own
 * panel; this one is the unaltered photograph, which is what makes it useful
 * as a check on everything else the listing claims.
 *
 * Renders nothing without a key, without coverage, or when the nearest
 * panorama is too far away to be of this place. A panel that says "Street View
 * unavailable" would be a dead promise, and this project does not ship those.
 */
export async function StreetViewPanel({
  latitude,
  longitude,
}: {
  latitude: number;
  longitude: number;
}) {
  const view = await lookupPano({ lat: latitude, lng: longitude });
  if (!view) return null;

  const src = embedViewUrl(view);
  if (!src) return null;

  return (
    <Card className="p-4" data-streetview>
      <h2 className="font-medium text-ink-900">{t("street.title")}</h2>
      <p className="mt-1 text-sm text-ink-600">{t("street.note")}</p>
      <div className="mt-3 rounded-lg overflow-hidden border border-ink-200">
        <iframe
          title={t("street.title")}
          src={src}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          className="block w-full h-[320px] border-0"
          allowFullScreen
        />
      </div>
      {/* Two facts about the photograph rather than about the place. Both are
          Google's own, neither is inferred, and "לא צוין" is the honest answer
          when Google does not say. */}
      <p className="mt-2 text-xs text-ink-500">
        {t("street.cameraDistance", { m: `⁨${view.metresAway}⁩` })}
        {" · "}
        {view.capturedAt ? (
          t("street.captured", { date: `⁨${view.capturedAt}⁩` })
        ) : (
          <span>{t("street.capturedUnknown")}</span>
        )}
      </p>
    </Card>
  );
}
