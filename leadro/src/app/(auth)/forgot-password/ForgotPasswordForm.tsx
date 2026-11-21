"use client";

import { useActionState } from "react";
import { Field, TextInput, buttonClasses } from "@/components/ui";
import { FormAlert } from "../../_components/FormAlert";
import { INITIAL_FORM_STATE } from "../../_lib/form-state";
import { requestPasswordResetAction } from "./actions";

export interface ForgotPasswordLabels {
  companyCode: string;
  email: string;
  submit: string;
  backToLogin: string;
}

export function ForgotPasswordForm({ labels }: { labels: ForgotPasswordLabels }) {
  const [state, formAction, isPending] = useActionState(requestPasswordResetAction, INITIAL_FORM_STATE);
  return (
    <form action={formAction} className="space-y-4">
      {state.success ? <FormAlert tone="success">{state.success}</FormAlert> : null}
      {state.error ? <FormAlert tone="danger">{state.error}</FormAlert> : null}
      <Field label={labels.companyCode} required>
        {(control) => <TextInput {...control} name="tenantSlug" defaultValue={state.fields?.tenantSlug} autoCapitalize="none" spellCheck={false} dir="ltr" />}
      </Field>
      <Field label={labels.email} required>
        {(control) => <TextInput {...control} name="email" type="email" defaultValue={state.fields?.email} autoComplete="username" dir="ltr" />}
      </Field>
      <button type="submit" disabled={isPending} className={`${buttonClasses.primary} w-full`}>
        {labels.submit}
      </button>
      <p className="text-center text-sm">
        <a href="/login" className="text-brand-700 underline">
          {labels.backToLogin}
        </a>
      </p>
    </form>
  );
}
