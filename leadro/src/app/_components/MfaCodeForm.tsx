"use client";

import { useActionState } from "react";
import { Field, TextInput, buttonClasses } from "@/components/ui";
import type { FormState } from "../_lib/form-state";
import { INITIAL_FORM_STATE } from "../_lib/form-state";
import { FormAlert } from "./FormAlert";

export interface MfaCodeFormProps {
  /** Server action that checks the code (challenge or enrollment confirmation). */
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  codeLabel: string;
  codeHint: string;
  submitLabel: string;
}

/** One-field form for a 6-digit authenticator code. Used for the login challenge and enrollment. */
export function MfaCodeForm({ action, codeLabel, codeHint, submitLabel }: MfaCodeFormProps) {
  const [state, formAction, isPending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <FormAlert tone="danger">{state.error}</FormAlert> : null}
      {state.success ? <FormAlert tone="success">{state.success}</FormAlert> : null}
      <Field label={codeLabel} hint={codeHint} required>
        {(control) => (
          <TextInput
            {...control}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={10}
            dir="ltr"
          />
        )}
      </Field>
      <button type="submit" disabled={isPending} className={`${buttonClasses.primary} w-full`}>
        {submitLabel}
      </button>
    </form>
  );
}
