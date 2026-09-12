"use client";

import { useActionState, useRef, useState } from "react";
import { setImageQuadAction } from "@/app/actions/admin";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { isUsableQuad, type Point, type Quad } from "@/lib/mockup";
import { Button } from "@/components/ui";

/**
 * Marking the face of a sign in a photo, by clicking its four corners.
 *
 * Four clicks rather than draggable handles: this is done once per photo by
 * one person, and a click-to-place tool has no drag state to get wrong. The
 * points are stored normalised, so the marking survives the photo being
 * displayed at any other size.
 */
export function MarkSurfaceForm({
  imageId,
  photoUrl,
  initialQuad,
}: {
  imageId: string;
  photoUrl: string;
  initialQuad: Quad | null;
}) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<Point[]>(initialQuad ?? []);
  const [state, action, pending] = useActionState<ActionState, FormData>(setImageQuadAction, undefined);
  const imgRef = useRef<HTMLImageElement | null>(null);

  function addPoint(e: React.MouseEvent<HTMLImageElement>) {
    if (points.length >= 4) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setPoints([
      ...points,
      {
        // Normalised against the displayed box, which is what makes the stored
        // value independent of how large this screen happens to be.
        x: Number(((e.clientX - rect.left) / rect.width).toFixed(4)),
        y: Number(((e.clientY - rect.top) / rect.height).toFixed(4)),
      },
    ]);
  }

  const complete = points.length === 4;
  const usable = complete && isUsableQuad(points as Quad);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {initialQuad ? `${t("mockup.markTitle")} · ${t("mockup.marked")}` : t("mockup.markTitle")}
      </Button>
    );
  }

  return (
    <div className="w-full mt-3 pt-3 border-t border-ink-100">
      <p className="text-sm font-medium text-ink-900">{t("mockup.markTitle")}</p>
      <p className="mt-1 text-sm text-ink-600">{t("mockup.markHint")}</p>

      <div className="mt-2 relative inline-block max-w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={photoUrl}
          alt=""
          onClick={addPoint}
          className="block max-w-full h-auto cursor-crosshair rounded"
        />
        {/* The marks, in physical pixels over the photo: the overlay shares the
            photo's coordinate space, which does not mirror in an RTL page. */}
        {points.map((p, i) => (
          <span
            key={i}
            className="absolute -translate-x-1/2 -translate-y-1/2 size-5 rounded-full bg-brand-600 text-white text-[10px] flex items-center justify-center ring-2 ring-white"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            aria-hidden="true"
          >
            {i + 1}
          </span>
        ))}
      </div>

      <p className="mt-2 text-xs text-ink-500">
        {complete
          ? usable
            ? t("mockup.markSave")
            : t("mockup.invalid")
          : t("mockup.corner", { n: points.length + 1 })}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <form action={action}>
          <input type="hidden" name="imageId" value={imageId} />
          <input type="hidden" name="quad" value={complete ? JSON.stringify(points) : ""} />
          {/* Disabled until the four points actually enclose a face: the server
              refuses the same cases, but there is no reason to let someone
              press a button that cannot work. */}
          <Button type="submit" size="sm" disabled={pending || !usable}>
            {t("mockup.markSave")}
          </Button>
        </form>

        <Button variant="ghost" size="sm" onClick={() => setPoints([])}>
          {t("mockup.markReset")}
        </Button>

        {initialQuad && (
          <form action={action}>
            <input type="hidden" name="imageId" value={imageId} />
            <input type="hidden" name="quad" value="" />
            <Button type="submit" variant="ghost" size="sm" disabled={pending}>
              {t("mockup.markClear")}
            </Button>
          </form>
        )}

        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t("common.close")}
        </Button>

        {state?.ok && <span className="text-xs text-ok-700">{state.message}</span>}
        {state && !state.ok && (
          <span role="alert" className="text-xs text-bad-700">
            {state.error}
          </span>
        )}
      </div>
    </div>
  );
}
