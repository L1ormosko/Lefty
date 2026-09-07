"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { registerAction, type FormState } from "../actions";
import { t } from "@/lib/labels";
import { Alert, Button, Card, Field, inputClass, cx } from "@/components/ui";

export function RegisterForm({ defaultRole }: { defaultRole: "ADVERTISER" | "MEDIA_OWNER" }) {
  const [state, action, pending] = useActionState<FormState, FormData>(registerAction, undefined);
  const [role, setRole] = useState(defaultRole);

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold text-ink-900">{t("auth.register")}</h1>
      <form action={action} className="mt-5 space-y-4">
        {state?.error && <Alert>{state.error}</Alert>}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-800 mb-2">{t("auth.role")}</legend>
          {(["ADVERTISER", "MEDIA_OWNER"] as const).map((r) => (
            <label
              key={r}
              className={cx(
                "flex items-start gap-3 rounded-md border p-3 cursor-pointer",
                role === r ? "border-brand-500 bg-brand-50" : "border-ink-200 hover:bg-ink-50"
              )}
            >
              <input
                type="radio"
                name="role"
                value={r}
                checked={role === r}
                onChange={() => setRole(r)}
                className="mt-1"
              />
              <span className="text-sm text-ink-800">
                {r === "ADVERTISER" ? t("auth.roleAdvertiser") : t("auth.roleOwner")}
              </span>
            </label>
          ))}
        </fieldset>

        <Field label={t("auth.name")} htmlFor="name" required error={state?.fields?.name}>
          <input id="name" name="name" required autoComplete="name" className={inputClass} />
        </Field>
        <Field label={t("auth.companyName")} htmlFor="companyName" hint={t("common.optional")} error={state?.fields?.companyName}>
          <input id="companyName" name="companyName" autoComplete="organization" className={inputClass} />
        </Field>
        <Field label={t("auth.email")} htmlFor="email" required error={state?.fields?.email}>
          <input id="email" name="email" type="email" dir="ltr" required autoComplete="email" className={inputClass} />
        </Field>
        <Field label={t("auth.phone")} htmlFor="phone" hint={t("common.optional")} error={state?.fields?.phone}>
          <input id="phone" name="phone" type="tel" dir="ltr" autoComplete="tel" className={inputClass} />
        </Field>
        <Field
          label={t("auth.password")}
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
          {pending ? t("common.loading") : t("auth.register")}
        </Button>
      </form>
      <p className="mt-4 text-sm text-ink-600">
        {t("auth.hasAccount")}{" "}
        <Link href="/login" className="text-brand-600 hover:underline">
          {t("auth.login")}
        </Link>
      </p>
    </Card>
  );
}
