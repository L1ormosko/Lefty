import { getPageContext } from "../../_lib/page-context";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export default async function ForgotPasswordPage() {
  const { t } = await getPageContext();
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">{t("AUTH_UI.FORGOT_TITLE")}</h1>
      <p className="mb-5 text-sm text-ink-muted">{t("AUTH_UI.FORGOT_INTRO")}</p>
      <ForgotPasswordForm
        labels={{
          companyCode: t("AUTH.COMPANY_CODE"),
          email: t("AUTH.EMAIL"),
          submit: t("AUTH_UI.FORGOT_SUBMIT"),
          backToLogin: t("AUTH_UI.BACK_TO_LOGIN"),
        }}
      />
    </>
  );
}
