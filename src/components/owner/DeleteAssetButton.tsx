"use client";

import { useState, useTransition } from "react";
import { deleteAssetAction } from "@/app/actions/assets";
import { t } from "@/lib/labels";
import { Button } from "@/components/ui";

/**
 * Removing a listing.
 *
 * The label and the confirmation both say what will really happen, because the
 * two cases are genuinely different: an untouched draft is deleted, while a
 * listing somebody has enquired about or booked is deactivated instead - its
 * bookings belong to the advertiser as much as to the owner, and deleting the
 * asset would take them down too. Offering one button called "delete" that
 * silently does either would be lying about one of them.
 */
export function DeleteAssetButton({
  assetId,
  status,
  engaged,
}: {
  assetId: string;
  status: string;
  engaged: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  const hardDelete = status === "DRAFT" && !engaged;
  if (status === "INACTIVE" && !hardDelete) return null;

  const label = hardDelete ? t("asset.delete") : t("asset.takeDown");
  const question = hardDelete
    ? t("asset.deleteConfirm")
    : engaged
      ? t("asset.takeDownConfirmEngaged")
      : t("asset.takeDownConfirm");

  if (done) {
    return (
      <p role="status" className="text-xs text-ink-600 w-full">
        {done}
      </p>
    );
  }

  return (
    <>
      {!confirming ? (
        <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          {label}
        </Button>
      ) : (
        <span className="flex flex-wrap items-center gap-2 w-full">
          <span className="text-xs text-ink-700">{question}</span>
          <Button
            variant="danger"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await deleteAssetAction(assetId);
                if (res && !res.ok) setError(res.error ?? t("common.error"));
                else setDone(res?.message ?? label);
              })
            }
          >
            {pending ? t("common.loading") : label}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </Button>
        </span>
      )}
      {error && (
        <p role="alert" className="text-xs text-bad-700 w-full">
          {error}
        </p>
      )}
    </>
  );
}
