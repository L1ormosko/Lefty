"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toggleSavedAction } from "@/app/actions/saved";
import { t } from "@/lib/labels";
import { Button } from "./ui";

export function SaveAssetButton({
  assetId,
  initiallySaved,
  signedIn,
}: {
  assetId: string;
  initiallySaved: boolean;
  signedIn: boolean;
}) {
  const [saved, setSaved] = useState(initiallySaved);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!signedIn) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent(`/assets/${assetId}`)}`}
        className="text-sm text-brand-600 hover:underline shrink-0"
      >
        {t("asset.save")}
      </Link>
    );
  }

  return (
    <div className="shrink-0 text-end">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        aria-pressed={saved}
        onClick={() =>
          start(async () => {
            const res = await toggleSavedAction(assetId);
            if (res.error) setError(res.error);
            else {
              setError(null);
              setSaved(!!res.saved);
            }
          })
        }
      >
        {saved ? `✓ ${t("asset.saved")}` : t("asset.save")}
      </Button>
      {error && (
        <p className="text-xs text-bad-700 mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
