"use client";

import { useState, useTransition } from "react";
import { setAssetStatusAction } from "@/app/actions/assets";
import { t } from "@/lib/labels";
import { Button } from "@/components/ui";

export function AssetStatusToggle({ assetId, status }: { assetId: string; status: string }) {
  const [current, setCurrent] = useState(status);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const next = current === "ACTIVE" ? "INACTIVE" : "ACTIVE";

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await setAssetStatusAction(assetId, next);
            if (res && !res.ok) setError(res.error ?? t("common.error"));
            else setCurrent(next);
          })
        }
      >
        {next === "ACTIVE" ? t("admin.activate") : t("admin.deactivate")}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-bad-700 w-full">
          {error}
        </p>
      )}
    </>
  );
}
