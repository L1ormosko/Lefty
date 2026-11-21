import { redirect } from "next/navigation";
import type { MessageKey } from "@/lib/i18n";
import { getPageContext } from "../../_lib/page-context";
import { LoginForm } from "./LoginForm";

/** Whitelist: only these `?notice=` values are ever shown, so the query string cannot inject text. */
const NOTICE_KEYS: Record<string, MessageKey> = {
  invitation_accepted: "AUTH_UI.NOTICE_INVITATION_ACCEPTED",
  password_reset: "AUTH_UI.NOTICE_PASSWORD_RESET",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { actor, mfaPending, t } = await getPageContext();
  if (actor) redirect(mfaPending ? "/login/mfa" : "/");

  const { notice } = await searchParams;
  const noticeKey = notice ? NOTICE_KEYS[notice] : undefined;

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">{t("AUTH.LOGIN_TITLE")}</h1>
      <p className="mb-5 text-sm text-ink-muted">{t("AUTH_UI.LOGIN_INTRO")}</p>
      <LoginForm
        notice={noticeKey ? t(noticeKey) : undefined}
        labels={{
          companyCode: t("AUTH.COMPANY_CODE"),
          email: t("AUTH.EMAIL"),
          password: t("AUTH.PASSWORD"),
          submit: t("AUTH.SIGN_IN"),
          forgotPassword: t("AUTH_UI.FORGOT_PASSWORD_LINK"),
        }}
      />
    </>
  );
}
