"use client";

import { useActionState, useRef } from "react";
import { postInquiryMessageAction, type ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Alert, Button, textareaClass } from "./ui";

/**
 * Add a message to an inquiry, from either side.
 *
 * Unlike the single-response form it replaces, this does not disappear after a
 * successful send: the conversation continues, so the box has to still be
 * there for the next message.
 */
export function InquiryMessageForm({ inquiryId }: { inquiryId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(postInquiryMessageAction, undefined);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await action(formData);
        formRef.current?.reset();
      }}
      className="space-y-2"
    >
      <input type="hidden" name="inquiryId" value={inquiryId} />
      {state && !state.ok && state.error && <Alert>{state.error}</Alert>}
      <label htmlFor={`msg-${inquiryId}`} className="block text-sm font-medium text-ink-800">
        {t("inquiry.newMessage")}
      </label>
      <textarea
        id={`msg-${inquiryId}`}
        name="body"
        rows={3}
        required
        className={textareaClass}
        placeholder={t("inquiry.messagePlaceholder")}
      />
      {state && !state.ok && state.fields?.body && (
        <p role="alert" className="text-xs text-bad-700">
          {state.fields.body}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? t("common.loading") : t("inquiry.send")}
      </Button>
    </form>
  );
}
