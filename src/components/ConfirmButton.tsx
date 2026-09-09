"use client";

import { useState, useTransition } from "react";
import { t } from "@/lib/labels";
import { Button } from "./ui";

/**
 * A destructive action that asks first.
 *
 * Cancelling a booking and deactivating a user both fired on a single click,
 * with no confirmation and nothing to undo - one mis-tap ends someone else's
 * campaign. The confirmation is inline rather than a modal because these
 * buttons live inside list rows, and a dialog over a row loses the context of
 * which row it is about.
 */
export function ConfirmButton({
  question,
  label,
  confirmLabel,
  variant = "secondary",
  onConfirm,
}: {
  question: string;
  label: string;
  confirmLabel?: string;
  variant?: "secondary" | "danger" | "ghost";
  onConfirm: () => Promise<{ ok: boolean; error?: string } | void>;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!asking) {
    return (
      <div>
        <Button variant={variant} size="sm" onClick={() => setAsking(true)}>
          {label}
        </Button>
        {error && (
          <p role="alert" className="text-xs text-bad-700 mt-1">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-700">{question}</span>
      <Button
        variant="danger"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await onConfirm();
            if (res && !res.ok) {
              setError(res.error ?? t("common.error"));
              setAsking(false);
            }
          })
        }
      >
        {pending ? t("common.loading") : (confirmLabel ?? label)}
      </Button>
      {/* Deliberately not "ביטול": the action being confirmed is often itself
          called ביטול (cancel this booking), and two adjacent buttons reading
          the same word while meaning opposite things is how someone ends the
          wrong thing. */}
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)} disabled={pending}>
        {t("common.back")}
      </Button>
    </div>
  );
}
