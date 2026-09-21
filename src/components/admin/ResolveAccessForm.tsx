"use client";

import { useActionState } from "react";
import { resolveAccessRequestAction } from "@/app/actions/access";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Button, inputClass } from "@/components/ui";

/**
 * Closing a request.
 *
 * The note is not decoration: it is sent to the customer, so "handled" is
 * never a request that simply disappeared from their side. Two outcomes,
 * because "we spoke and they said no" and "we set them up" are different
 * facts about the same row and the next person reading it needs to know
 * which.
 */
export function ResolveAccessForm({ requestId }: { requestId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    resolveAccessRequestAction,
    undefined
  );

  if (state?.ok) {
    return <p className="text-sm text-ok-700">{state.message}</p>;
  }

  return (
    <form action={action} className="mt-3 pt-3 border-t border-ink-100 space-y-2">
      <input type="hidden" name="requestId" value={requestId} />
      <label className="block text-sm">
        <span className="block text-xs text-ink-500 mb-1">{t("admin.accessNote")}</span>
        <input type="text" name="note" maxLength={500} className={inputClass} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="RESOLVED" size="sm" disabled={pending}>
          {t("admin.accessResolve")}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="DISMISSED"
          size="sm"
          variant="secondary"
          disabled={pending}
        >
          {t("admin.accessDismiss")}
        </Button>
      </div>
      {state && !state.ok && (
        <p role="alert" className="text-xs text-bad-700">
          {state.error}
        </p>
      )}
    </form>
  );
}
