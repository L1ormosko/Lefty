"use client";

import { useState, useTransition } from "react";
import { deleteAssetImageAction } from "@/app/actions/assets";
import { t } from "@/lib/labels";
import { Alert, Button } from "@/components/ui";

type Img = { id: string; url: string; isPrimary: boolean };

export function ImageUploader({ assetId, initial }: { assetId: string; initial: Img[] }) {
  const [images, setImages] = useState<Img[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [, startDelete] = useTransition();

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    for (const file of Array.from(files)) {
      const body = new FormData();
      body.set("assetId", assetId);
      body.set("file", file);
      try {
        const res = await fetch("/api/uploads", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) setError(data.error ?? t("common.error"));
        else setImages((prev) => [...prev, data.image]);
      } catch {
        setError(t("common.error"));
      }
    }
    setUploading(false);
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <label className="block">
        <span className="sr-only">{t("wizard.images")}</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={uploading}
          onChange={(e) => upload(e.target.files)}
          className="block w-full text-sm text-ink-700 file:me-3 file:rounded-md file:border-0 file:bg-ink-900 file:px-4 file:py-2 file:text-white file:text-sm"
        />
      </label>
      <p className="text-xs text-ink-500">JPG / PNG / WebP · עד 8MB לתמונה</p>
      {uploading && <p className="text-sm text-ink-600">{t("common.loading")}</p>}

      {images.length === 0 ? (
        <p className="text-sm text-ink-500">{t("asset.noImages")}</p>
      ) : (
        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {images.map((img) => (
            <li key={img.id} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" className="aspect-square object-cover rounded border border-ink-200 w-full" />
              {img.isPrimary && (
                <span className="absolute top-1 start-1 rounded bg-ink-900/80 text-white text-[10px] px-1.5 py-0.5">
                  ראשית
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="mt-1 w-full"
                onClick={() =>
                  startDelete(async () => {
                    const res = await deleteAssetImageAction(img.id);
                    if (res && !res.ok) setError(res.error ?? t("common.error"));
                    else setImages((prev) => prev.filter((i) => i.id !== img.id));
                  })
                }
              >
                {t("common.delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
