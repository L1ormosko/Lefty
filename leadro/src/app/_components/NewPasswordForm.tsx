"use client";

import { useActionState } from "react";
import { Field, TextInput, buttonClasses } from "@/components/ui";
import { INITIAL_FORM_STATE, type FormState } from "../_lib/form-state";
import { FormAlert } from "./FormAlert";

export interface NewPasswordFormProps {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  /** Single-use token from the e-mailed link; sent back untouched in a hidden field. */
  token: string;
  labels: { password: string; confirm: string; policyHint: string; submit: string };
}

/** Choose-a-password form shared by invitation acceptance and password reset. */
export function NewPasswordForm({ action, token, labels }: NewPasswordFormProps) {
  const [state, formAction, isPending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <FormAlert tone="danger">{state.error}</FormAlert> : null}
      <input type="hidden" name="token" value={token} />
      <Field label={labels.password} hint={labels.policyHint} required>
        {(control) => <TextInput {...control} name="password" type="password" autoComplete="new-password" minLength={12} dir="ltr" />}
      </Field>
      <Field label={labels.confirm} required>
        {(control) => <TextInput {...control} name="confirmPassword" type="password" autoComplete="new-password" dir="ltr" />}
      </Field>
      <button type="submit" disabled={isPending} className={`${buttonClasses.primary} w-full`}>
        {labels.submit}
      </button>
    </form>
  );
}
