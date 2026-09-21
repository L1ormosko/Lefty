"use client";

import { useActionState } from "react";
import { requestAccessAction } from "@/app/actions/access";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Alert, Button, Field, textareaClass } from "@/components/ui";

/**
 * The button that was missing.
 *
 * Small on purpose. Everything VELTO needs in order to come back to this
 * person - who they are, how to reach them, what their account already looks
 * like - is on their account already, so asking for it again would be a form
 * that exists to look like a form. The one open field is the only thing the
 * account cannot say: what they are actually after.
 */
export function RequestAccessForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    requestAccessAction,
    undefined
  );

  if (state?.ok) {
    return <Alert kind="success">{state.message}</Alert>;
  }

  return (
    <form action={action} className="space-y-3">
      {state?.error && <Alert>{state.error}</Alert>}
      <Field label={t("access.messageLabel")} htmlFor="message">
        <textarea
          id="message"
          name="message"
          rows={4}
          maxLength={1000}
          className={textareaClass}
          placeholder={t("access.messagePlaceholder")}
        />
      </Field>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? t("common.loading") : t("access.submit")}
      </Button>
      <p className="text-xs text-ink-500">{t("access.formNote")}</p>
    </form>
  );
}
