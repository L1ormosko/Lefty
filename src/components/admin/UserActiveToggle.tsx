"use client";

import { useState, useTransition } from "react";
import { setUserActiveAction } from "@/app/actions/admin";
import { t } from "@/lib/labels";
import { Button } from "@/components/ui";

export function UserActiveToggle({ userId, isActive }: { userId: string; isActive: boolean }) {
  const [active, setActive] = useState(isActive);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await setUserActiveAction(userId, !active);
            if (res && !res.ok) setError(res.error ?? t("common.error"));
            else {
              setError(null);
              setActive(!active);
            }
          })
        }
      >
        {active ? t("admin.deactivate") : t("admin.activate")}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-bad-700 basis-full">
          {error}
        </p>
      )}
    </>
  );
}
