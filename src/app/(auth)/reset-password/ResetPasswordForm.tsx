"use client";

import Link from "next/link";
import { useActionState } from "react";
import { resetPasswordAction, type FormState } from "../actions";
import { t } from "@/lib/labels";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(resetPasswordAction, undefined);

  if (!token) {
    return (
      <Card className="p-6">
        <Alert>{t("auth.resetTokenInvalid")}</Alert>
        <Link href="/forgot-password" className="mt-4 inline-block text-sm text-brand-600 hover:underline">
          {t("auth.forgotPasswordTitle")}
        </Link>
      </Card>
    );
  }

  if (state?.success) {
    return (
      <Card className="p-6">
        <Alert kind="success">{state.success}</Alert>
        <Link href="/login" className="mt-4 inline-block text-sm text-brand-600 hover:underline">
          {t("auth.login")}
        </Link>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold text-ink-900">{t("auth.resetPasswordTitle")}</h1>
      <form action={action} className="mt-5 space-y-4">
        <input type="hidden" name="token" value={token} />
        {state?.error && <Alert>{state.error}</Alert>}
        <Field
          label={t("auth.newPassword")}
          htmlFor="password"
          required
          hint={t("auth.passwordRule")}
          error={state?.fields?.password ? t(state.fields.password) : undefined}
        >
          <input
            id="password"
            name="password"
            type="password"
            dir="ltr"
            required
            minLength={8}
            autoComplete="new-password"
            className={inputClass}
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? t("common.loading") : t("auth.resetPasswordSubmit")}
        </Button>
      </form>
    </Card>
  );
}
