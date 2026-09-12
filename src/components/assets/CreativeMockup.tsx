"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/labels";
import { mockupMatrix3d, type Quad } from "@/lib/mockup";
import { Button, Card } from "@/components/ui";

/**
 * An advertiser's artwork, previewed on a photo of the actual sign.
 *
 * The file never leaves the browser. It is read as an object URL, drawn as an
 * ordinary <img> under a CSS transform, and revoked when it is replaced - no
 * upload, no server round trip, nothing stored. That is a deliberate product
 * decision and not only a cheap one: unreleased campaign artwork is the most
 * confidential thing an advertiser has, and the safest way to hold it is not
 * to hold it.
 *
 * Rendered only when the photo has a marked face. Without one there is no
 * honest place to put the artwork, and guessing a rectangle would produce a
 * picture of a sign carrying an ad that does not fit it.
 */

/** Comfortably larger than any real ad file; a guard against a 200MB TIFF. */
const MAX_BYTES = 25 * 1024 * 1024;

export function CreativeMockup({ photoUrl, quad }: { photoUrl: string; quad: Quad }) {
  const [creative, setCreative] = useState<{ url: string; width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photoSize, setPhotoSize] = useState<{ width: number; height: number } | null>(null);
  const photoRef = useRef<HTMLImageElement | null>(null);
  const objectUrl = useRef<string | null>(null);

  // The transform is in the photo's *displayed* pixels, so it has to be
  // recomputed whenever the photo is laid out at a different size - a phone
  // rotating, a panel resizing. The quad is normalised precisely so that this
  // is the only thing that has to change.
  useEffect(() => {
    const img = photoRef.current;
    if (!img) return;
    const measure = () => setPhotoSize({ width: img.clientWidth, height: img.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(img);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  function onPick(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(t("mockup.notAnImage"));
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(t("mockup.fileTooBig"));
      return;
    }

    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(file);
    objectUrl.current = url;

    // The natural size is needed before the transform can be built: the
    // matrix maps the artwork's own pixel rectangle onto the sign.
    const probe = new Image();
    probe.onload = () => setCreative({ url, width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => setError(t("mockup.notAnImage"));
    probe.src = url;
  }

  function clear() {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setCreative(null);
  }

  const transform =
    creative && photoSize && photoSize.width > 0
      ? mockupMatrix3d({
          quad,
          photoWidth: photoSize.width,
          photoHeight: photoSize.height,
          creativeWidth: creative.width,
          creativeHeight: creative.height,
        })
      : null;

  return (
    // The hook lives on a wrapper: Card takes className and children only, so
    // an attribute passed to it is silently dropped.
    <div data-mockup>
    <Card className="p-4">
      <h2 className="font-medium text-ink-900">{t("mockup.title")}</h2>
      {/* Said before the picture, not under it. */}
      <p className="mt-1 text-sm font-medium text-ink-800">{t("mockup.disclaimer")}</p>
      <p className="mt-1 text-sm text-ink-600">{t("mockup.explain")}</p>

      <div className="mt-3 relative overflow-hidden rounded-lg bg-ink-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={photoRef} src={photoUrl} alt="" className="block w-full h-auto" />

        {creative && transform && (
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={creative.url}
              alt=""
              width={creative.width}
              height={creative.height}
              style={{
                position: "absolute",
                top: 0,
                // Physical left, not inset-inline: the transform is computed
                // in the photo's own coordinates, which do not flip in RTL.
                left: 0,
                maxWidth: "none",
                transform,
                transformOrigin: "0 0",
              }}
            />
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex">
          <span className="sr-only">{t("mockup.choose")}</span>
          <input
            type="file"
            accept="image/*"
            id="mockup-file"
            className="block text-sm file:me-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-white file:text-sm hover:file:bg-brand-700"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
        </label>
        {creative && (
          <Button variant="ghost" size="sm" onClick={clear}>
            {t("mockup.clear")}
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-bad-700">
          {error}
        </p>
      )}

      <p className="mt-3 text-xs text-ink-500">{t("mockup.limitations")}</p>
    </Card>
    </div>
  );
}
