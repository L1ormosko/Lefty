"use client";

import { useActionState } from "react";
import { detectMissingSurfacesAction } from "@/app/actions/admin";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Alert, Button } from "@/components/ui";

/**
 * Running detection over photographs uploaded before it existed.
 *
 * A button rather than the one-off script the other backfills in prisma/ are,
 * and not out of preference: the production database accepts no external
 * connections, so a script run from a laptop cannot reach the rows that need
 * it. A tool that works everywhere except where it is needed is not a tool.
 *
 * Ten photos a press, because each one is a call to a vision model. The
 * message says how many are left, so pressing again is an informed decision
 * rather than a guess at whether anything happened.
 */
export function DetectSurfacesForm({ pending }: { pending: number }) {
  const [state, action, running] = useActionState<ActionState, FormData>(
    detectMissingSurfacesAction,
    undefined
  );

  // Nothing waiting and nothing said yet: no control at all. A button whose
  // only possible outcome is "there was nothing to do" is noise on a screen
  // that is already a queue.
  if (pending === 0 && !state) return null;

  return (
    <div className="mb-4 rounded-lg border border-ink-200 bg-white p-4">
      <p className="text-sm font-medium text-ink-900">{t("mockup.detectTitle")}</p>
      <p className="mt-1 text-sm text-ink-600">{t("mockup.detectHint")}</p>
      <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={running}>
          {running ? t("common.loading") : t("mockup.detectRun")}
        </Button>
        {pending > 0 && <span className="text-sm text-ink-500">{pending}</span>}
      </form>
      {state && (
        <div className="mt-3">
          <Alert kind={state.ok ? "success" : "error"}>
            {state.ok ? state.message : state.error}
          </Alert>
        </div>
      )}
    </div>
  );
}
