"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/labels";
import { mockupMatrix3d, ratioMatches, type Quad } from "@/lib/mockup";
import { angleLabel, blend, orderFrames, scrub, step, type Frame } from "@/lib/turntable";
import { Button, Card, Collapsible, cx } from "@/components/ui";

/**
 * An advertiser's artwork, previewed on photographs of the actual sign.
 *
 * The file never leaves the browser. It is read as an object URL, drawn as an
 * ordinary <img> under a CSS transform, and revoked when it is replaced - no
 * upload, no server round trip, nothing stored. That is a deliberate product
 * decision and not only a cheap one: unreleased campaign artwork is the most
 * confidential thing an advertiser has, and the safest way to hold it is not
 * to hold it.
 *
 * With more than one marked photo the panel becomes a turntable: dragging
 * across it moves between the angles the sign was photographed from, and the
 * artwork is re-projected onto each one's own marked face. That re-projection
 * is what sells the depth - the ad's perspective changes with the view, so it
 * reads as attached to the sign rather than pasted onto a picture. It is not a
 * 3D model and the panel says so; nothing between two photographs is invented.
 *
 * Rendered only when a photo has a marked face. Without one there is no honest
 * place to put the artwork, and guessing a rectangle would produce a picture of
 * a sign carrying an ad that does not fit it.
 */

/** Comfortably larger than any real ad file; a guard against a 200MB TIFF. */
const MAX_BYTES = 25 * 1024 * 1024;

/** One photo of this listing that has its sign face marked. */
export type MarkedPhoto = {
  id: string;
  url: string;
  quad: Quad;
  angleDeg?: number | null;
  /**
   * Whether a model found this face rather than a person marking it.
   *
   * Said on screen, not because the detection is untrustworthy - one that
   * reaches this component has already cleared the confidence and shape
   * checks - but because the reader is entitled to know which it is. The
   * whole panel rests on the face being in the right place, and a machine's
   * answer presented as a person's is the kind of small silence that makes
   * everything next to it worth less.
   */
  detected?: boolean;
  /**
   * Whether the picture under the artwork is Google's rather than the
   * owner's.
   *
   * This one is not a footnote. A Street View frame is a photograph of the
   * street on whatever day Google drove it, and an advertiser deciding to
   * spend money on a site is entitled to know they are looking at that rather
   * than at a photograph the owner took of their own sign.
   */
  streetView?: boolean;
};

/** Checked per gesture rather than cached: the setting can change mid-session. */
function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

const ANGLE_LABELS = {
  left: "mockup.angleLeft",
  front: "mockup.angleFront",
  right: "mockup.angleRight",
  unknown: "mockup.angleUnknown",
} as const;

export function CreativeMockup({
  photos,
  faceRatio,
  widthCm,
  heightCm,
}: {
  photos: MarkedPhoto[];
  /** The sign's real width/height, or null when the owner published none. */
  faceRatio: number | null;
  widthCm: number | null;
  heightCm: number | null;
}) {
  // Ordered once, by the angle each photo was taken from where that is known.
  const frames: Frame[] = useMemo(
    () => orderFrames(photos.map((p) => ({ ...p, angleDeg: p.angleDeg ?? null }))),
    [photos]
  );

  // A continuous position: 1.4 is "between the second and third angles", which
  // is what the crossfade needs.
  const [pos, setPos] = useState(0);
  const { index, next, t: mix } = blend(Math.min(pos, frames.length - 1));
  const frame = frames[Math.min(index, frames.length - 1)];
  const nextFrame = frames[Math.min(next, frames.length - 1)];

  /*
   * Facts about the picture currently on screen, rather than about the set.
   *
   * orderFrames types its result as Frame, so the provenance fields do not
   * survive the trip even though the values do; looking the photo back up by
   * id is the honest way to read them. Per-frame and not "any of them",
   * because a listing can hold an owner's photograph and a Street View frame
   * at once, and a note that applied to the other one would be worse than no
   * note - it would be a wrong one.
   */
  const shown = photos.find((p) => p.id === frame?.id);

  const [creative, setCreative] = useState<{ url: string; width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photoSize, setPhotoSize] = useState<{ width: number; height: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
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

  // Decode every angle up front. Without this the first drag stutters on the
  // frame it is moving towards, which reads as the feature being broken rather
  // than as a slow network.
  useEffect(() => {
    for (const f of frames) {
      const img = new Image();
      img.src = f.url;
    }
  }, [frames]);

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

  /** The artwork's transform on one particular angle's marked face. */
  const transformFor = useCallback(
    (quad: Quad) =>
      creative && photoSize && photoSize.width > 0
        ? mockupMatrix3d({
            quad,
            photoWidth: photoSize.width,
            photoHeight: photoSize.height,
            creativeWidth: creative.width,
            creativeHeight: creative.height,
            faceRatio,
          })
        : null,
    [creative, photoSize, faceRatio]
  );

  // --- the turntable gesture -------------------------------------------------
  //
  // Horizontal only, and only once the drag has proved itself horizontal. A
  // pointer capture taken on the first move would swallow vertical scrolling on
  // a phone, which is a far worse bug than a turntable that ignores a gesture.
  const drag = useRef<{ id: number; x: number; y: number; pos: number; active: boolean } | null>(null);
  const many = frames.length > 1;

  function onPointerDown(e: React.PointerEvent) {
    if (!many) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, pos, active: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;

    if (!d.active) {
      if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(dy)) return;
      d.active = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    const width = stageRef.current?.clientWidth ?? 0;
    const moved = scrub(d.pos, dx, width, frames.length);
    // Someone who asked for less motion gets the angles, not the dissolve
    // between them: the view snaps from one photograph to the next.
    setPos(reducedMotion() ? Math.round(moved) : moved);
  }

  function endDrag(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.active) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      // Settle on the nearest photographed angle rather than resting between
      // two half-faded ones.
      setPos((p) => Math.round(p));
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!many) return;
    // Physical, not textual: the right arrow moves the viewpoint rightwards
    // around the sign in both directions of text.
    if (e.key === "ArrowRight") setPos((p) => step(p, 1, frames.length));
    else if (e.key === "ArrowLeft") setPos((p) => step(p, -1, frames.length));
    else return;
    e.preventDefault();
  }

  const creativeRatio = creative ? creative.width / creative.height : null;
  const fits = creativeRatio != null && ratioMatches(faceRatio, creativeRatio);
  const showRatioWarning = creativeRatio != null && faceRatio != null && !fits;
  const ratioText = (r: number) => `${r.toFixed(2)}:1`;
  const labelOf = (f: Frame) => t(ANGLE_LABELS[angleLabel(f.angleDeg)]);

  return (
    // The hook lives on a wrapper: Card takes className and children only, so
    // an attribute passed to it is silently dropped.
    <div data-mockup>
      <Card className="p-4">
        <h2 className="font-medium text-ink-900">{t("mockup.title")}</h2>
        {/*
          The one line that has to be read, said before the picture rather than
          under it: this is a simulation, not a photograph of a printed ad.

          Everything else that used to sit here - how the preview works, what
          it cannot account for, what the turntable is and is not - moved to a
          disclosure at the foot of the panel. Seven stacked paragraphs of
          caveat is not a careful product, it is a paragraph nobody finishes,
          and it buried the two things that change what the advertiser does:
          this line, and the size they have to match.
        */}
        <p className="mt-1 text-sm font-medium text-ink-800">{t("mockup.disclaimer")}</p>

        {/* One quiet line, and only when it is true. It goes under the
            disclaimer rather than beside it: "this is a simulation" is the
            statement that changes what the advertiser does, and how the face
            was located is the footnote to it. */}
        {shown?.streetView && (
          <p className="mt-1 text-sm text-ink-700">{t("mockup.streetViewPhoto")}</p>
        )}
        {shown?.detected && <p className="mt-1 text-sm text-ink-600">{t("mockup.detected")}</p>}

        {/* What the advertiser has to match. Stated before they choose a file,
            not after the preview has already surprised them. */}
        <p className="mt-2 text-sm text-ink-700">
          {faceRatio != null && widthCm && heightCm ? (
            // Only the numbers are isolated, never the sentence. Wrapping the
            // whole Hebrew line in <Num> forces it left-to-right and reorders
            // it - "900x300" came out as "300x900". Same trap the price line
            // fell into.
            t("mockup.faceSize", {
              w: `⁨${widthCm}⁩`,
              h: `⁨${heightCm}⁩`,
              ratio: `⁨${ratioText(faceRatio)}⁩`,
            })
          ) : (
            <span className="text-ink-600">{t("mockup.faceSizeUnknown")}</span>
          )}
        </p>

        {many && (
          <p className="mt-2 text-sm text-ink-700">
            {t("mockup.turntableHint", { count: `⁨${frames.length}⁩` })}
          </p>
        )}

        <div
          ref={stageRef}
          data-turntable={many ? frames.length : undefined}
          role={many ? "slider" : undefined}
          aria-label={many ? t("mockup.turntable") : undefined}
          aria-valuemin={many ? 1 : undefined}
          aria-valuemax={many ? frames.length : undefined}
          aria-valuenow={many ? Math.round(pos) + 1 : undefined}
          aria-valuetext={many ? labelOf(frame) : undefined}
          tabIndex={many ? 0 : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className={cx(
            "mt-3 relative overflow-hidden rounded-lg bg-ink-100",
            // Vertical panning stays with the page; only horizontal gestures
            // reach the turntable.
            many && "touch-pan-y cursor-ew-resize focus:outline-none focus:ring-2 focus:ring-brand-500"
          )}
        >
          {/* The angle being shown. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={photoRef}
            src={frame.url}
            alt=""
            draggable={false}
            className="block w-full h-auto select-none"
          />
          {creative && transformFor(frame.quad) && (
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={creative.url}
                alt=""
                width={creative.width}
                height={creative.height}
                data-creative
                style={{
                  position: "absolute",
                  top: 0,
                  // Physical left, not inset-inline: the transform is computed
                  // in the photo's own coordinates, which do not flip in RTL.
                  left: 0,
                  maxWidth: "none",
                  transform: transformFor(frame.quad)!,
                  transformOrigin: "0 0",
                }}
              />
            </div>
          )}

          {/* The angle being moved towards, dissolving in over the top. Present
              only mid-drag: at rest mix is exactly 0 and this is not rendered,
              so a settled sign is never a double exposure. */}
          {mix > 0 && nextFrame !== frame && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ opacity: mix }}
              aria-hidden="true"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={nextFrame.url} alt="" draggable={false} className="block w-full h-auto" />
              {creative && transformFor(nextFrame.quad) && (
                // Re-projected onto this angle's own marked face. This is the
                // whole feature: the ad turns with the sign.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={creative.url}
                  alt=""
                  width={creative.width}
                  height={creative.height}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    maxWidth: "none",
                    transform: transformFor(nextFrame.quad)!,
                    transformOrigin: "0 0",
                  }}
                />
              )}
            </div>
          )}
        </div>

        {/* One button per angle. Dragging is not a visible affordance, so the
            thumbnails stay as the way in for anyone who never tries it. */}
        {many && (
          // Physically left to right, not with the text: these are places
          // someone stood, so the view from the sign's left belongs on the
          // left, matching the direction the drag moves them in.
          <div
            dir="ltr"
            className="mt-3 flex flex-wrap gap-2"
            role="group"
            aria-label={t("mockup.views")}
          >
            {frames.map((f, i) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setPos(i)}
                aria-pressed={i === Math.round(pos)}
                className={cx(
                  "rounded-md overflow-hidden border-2 transition-colors",
                  i === Math.round(pos) ? "border-brand-500" : "border-ink-200 hover:border-ink-300"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.url} alt="" className="block h-14 w-20 object-cover" />
                <span className="sr-only">{labelOf(f)}</span>
              </button>
            ))}
          </div>
        )}

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

        {/* Not an error: the file is fine, it is simply a different shape from
            the sign, and the preview already shows exactly what that means -
            so a line in the warning colour, not a tinted panel. */}
        {showRatioWarning && (
          <p className="mt-2 text-sm text-warn-800">
            {t("mockup.ratioOff", {
              face: `⁨${ratioText(faceRatio!)}⁩`,
              file: `⁨${ratioText(creativeRatio!)}⁩`,
            })}
          </p>
        )}
        {fits && <p className="mt-2 text-sm text-ok-700">{t("mockup.ratioOk")}</p>}

        {/* The caveats, kept in full and kept out of the way. Nothing is
            dropped - a reader who wants to know what the preview does not
            account for opens one row and gets every word that used to be
            stacked above. */}
        <div className="mt-4">
          <Collapsible title={t("mockup.howItWorks")}>
            <div className="space-y-2 text-sm text-ink-600">
              <p>{t("mockup.explain")}</p>
              {many && <p>{t("mockup.turntableNotModel")}</p>}
              <p>{t("mockup.limitations")}</p>
            </div>
          </Collapsible>
        </div>
      </Card>
    </div>
  );
}
