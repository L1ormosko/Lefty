"use client";

import { useActionState, useState } from "react";
import { setUserRoleAction } from "@/app/actions/admin";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Button, inputClass } from "@/components/ui";

const ROLES = ["ADVERTISER", "MEDIA_OWNER", "ADMIN"] as const;

/**
 * Changing what someone is.
 *
 * Collapsed behind a link, like the subscription drawer beside it: this is a
 * rare action on a row that is mostly read, and a select box open on every
 * user invites a misclick on the one control that can hand over the platform.
 *
 * The confirmation is only on the way up. Promoting someone to ADMIN gives
 * them every listing, every user's details and the database export; demoting
 * is recoverable by any remaining admin, and the server refuses to demote the
 * last one.
 */
export function UserRoleForm({ userId, role }: { userId: string; role: string }) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(role);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setUserRoleAction,
    undefined
  );

  if (!open) {
    return (
      <div className="basis-full">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm text-brand-600 hover:underline"
        >
          {t("admin.roleChange")}
        </button>
        {state?.ok && <span className="ms-2 text-xs text-ok-700">{state.message}</span>}
      </div>
    );
  }

  return (
    <form
      action={action}
      className="basis-full border-t border-ink-100 pt-3 mt-1 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        // Handing someone the whole platform deserves one question.
        if (next === "ADMIN" && !confirm(t("admin.rolePromoteConfirm"))) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      <label className="text-sm">
        <span className="block text-xs text-ink-500 mb-1">{t("admin.role")}</span>
        <select
          name="role"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={`${inputClass} w-48`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`role.${r}`)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="sm" disabled={pending || next === role}>
        {pending ? t("common.loading") : t("common.save")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {t("common.cancel")}
      </Button>
      {state && !state.ok && (
        <p role="alert" className="basis-full text-xs text-bad-700">
          {state.error}
        </p>
      )}
      {state?.ok && <p className="basis-full text-xs text-ok-700">{state.message}</p>}
    </form>
  );
}
