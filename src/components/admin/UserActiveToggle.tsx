"use client";

import { useState } from "react";
import { setUserActiveAction } from "@/app/actions/admin";
import { t } from "@/lib/labels";
import { Button } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";

/**
 * Deactivating an account signs the person out everywhere immediately, so that
 * direction asks first. Re-activating is harmless and stays a single click -
 * a confirmation on a safe action just trains people to click through them.
 */
export function UserActiveToggle({ userId, isActive }: { userId: string; isActive: boolean }) {
  const [active, setActive] = useState(isActive);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: boolean) {
    const res = await setUserActiveAction(userId, next);
    if (res && !res.ok) {
      setError(res.error ?? t("common.error"));
      return res;
    }
    setError(null);
    setActive(next);
    return res;
  }

  return (
    <>
      {active ? (
        <ConfirmButton
          variant="ghost"
          label={t("admin.deactivate")}
          question={t("admin.deactivateConfirm")}
          onConfirm={() => apply(false)}
        />
      ) : (
        <Button variant="ghost" size="sm" onClick={() => void apply(true)}>
          {t("admin.activate")}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-bad-700 basis-full">
          {error}
        </p>
      )}
    </>
  );
}
