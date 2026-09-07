"use client";

import { useActionState, useState, useTransition } from "react";
import { setAssetStatusAdminAction, verifyAssetAction } from "@/app/actions/admin";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Alert, Button, inputClass } from "@/components/ui";

export function VerifyAssetForm({
  assetId,
  status,
  note,
}: {
  assetId: string;
  status: string;
  note: string | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(verifyAssetAction, undefined);
  const [current, setCurrent] = useState(status);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusPending, startStatus] = useTransition();

  return (
    <div className="space-y-2">
      {state?.ok && <Alert kind="success">{state.message}</Alert>}
      {state?.ok === false && state.error && <Alert>{state.error}</Alert>}
      {statusError && <Alert>{statusError}</Alert>}
      <form action={action} className="flex flex-wrap gap-2 items-center">
        <input type="hidden" name="assetId" value={assetId} />
        <input
          name="reviewNote"
          defaultValue={note ?? ""}
          placeholder={t("admin.reviewNote")}
          aria-label={t("admin.reviewNote")}
          className={`${inputClass} flex-1 min-w-48`}
        />
        <Button type="submit" name="decision" value="VERIFIED" size="sm" disabled={pending}>
          {t("admin.approveAsset")}
        </Button>
        <Button type="submit" name="decision" value="REJECTED" variant="secondary" size="sm" disabled={pending}>
          {t("admin.rejectAsset")}
        </Button>
      </form>
      {current !== "DRAFT" && (
        <Button
          variant="ghost"
          size="sm"
          disabled={statusPending}
          onClick={() => {
            const next = current === "ACTIVE" ? "INACTIVE" : "ACTIVE";
            startStatus(async () => {
              const res = await setAssetStatusAdminAction(assetId, next);
              if (res && !res.ok) setStatusError(res.error ?? t("common.error"));
              else {
                setStatusError(null);
                setCurrent(next);
              }
            });
          }}
        >
          {current === "ACTIVE" ? t("admin.deactivate") : t("admin.activate")}
        </Button>
      )}
    </div>
  );
}
