"use client";

import { useActionState } from "react";
import { respondToInquiryAction, type ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Alert, Button, textareaClass } from "./ui";

export function RespondForm({ inquiryId }: { inquiryId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(respondToInquiryAction, undefined);

  if (state?.ok) return <Alert kind="success">{state.message}</Alert>;

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="inquiryId" value={inquiryId} />
      {state?.error && <Alert>{state.error}</Alert>}
      <label htmlFor={`resp-${inquiryId}`} className="block text-sm font-medium text-ink-800">
        {t("dash.respond")}
      </label>
      <textarea
        id={`resp-${inquiryId}`}
        name="ownerResponse"
        rows={3}
        required
        className={textareaClass}
        placeholder="זמינות, מחיר סופי ותנאים"
      />
      {state?.fields?.ownerResponse && (
        <p role="alert" className="text-xs text-bad-700">
          {state.fields.ownerResponse}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? t("common.loading") : t("common.submit")}
      </Button>
    </form>
  );
}
