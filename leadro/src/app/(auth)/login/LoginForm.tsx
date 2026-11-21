"use client";

import { useActionState } from "react";
import { Field, TextInput, buttonClasses } from "@/components/ui";
import { FormAlert } from "../../_components/FormAlert";
import { INITIAL_FORM_STATE } from "../../_lib/form-state";
import { loginAction } from "./actions";

export interface LoginFormLabels {
  companyCode: string;
  email: string;
  password: string;
  submit: string;
  forgotPassword: string;
}

/** Company code + email + password. Messages come back from the server already translated. */
export function LoginForm({ labels, notice }: { labels: LoginFormLabels; notice?: string }) {
  const [state, formAction, isPending] = useActionState(loginAction, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="space-y-4">
      {notice ? <FormAlert tone="success">{notice}</FormAlert> : null}
      {state.error ? <FormAlert tone="danger">{state.error}</FormAlert> : null}
      <Field label={labels.companyCode} required>
        {(control) => (
          <TextInput {...control} name="tenantSlug" defaultValue={state.fields?.tenantSlug} autoComplete="organization" autoCapitalize="none" spellCheck={false} dir="ltr" />
        )}
      </Field>
      <Field label={labels.email} required>
        {(control) => <TextInput {...control} name="email" type="email" defaultValue={state.fields?.email} autoComplete="username" dir="ltr" />}
      </Field>
      <Field label={labels.password} required>
        {(control) => <TextInput {...control} name="password" type="password" autoComplete="current-password" dir="ltr" />}
      </Field>
      <button type="submit" disabled={isPending} className={`${buttonClasses.primary} w-full`}>
        {labels.submit}
      </button>
      <p className="text-center text-sm">
        <a href="/forgot-password" className="text-brand-700 underline">
          {labels.forgotPassword}
        </a>
      </p>
    </form>
  );
}
