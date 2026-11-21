import { FormAlert } from "../../_components/FormAlert";
import { NewPasswordForm } from "../../_components/NewPasswordForm";
import { getPageContext } from "../../_lib/page-context";
import { resetPasswordAction } from "./actions";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await getPageContext();
  const { token } = await searchParams;

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">{t("AUTH_UI.RESET_TITLE")}</h1>
      <p className="mb-5 text-sm text-ink-muted">{t("AUTH_UI.RESET_INTRO")}</p>
      {token ? (
        <NewPasswordForm
          action={resetPasswordAction}
          token={token}
          labels={{
            password: t("AUTH_UI.NEW_PASSWORD"),
            confirm: t("AUTH_UI.CONFIRM_PASSWORD"),
            policyHint: t("AUTH_UI.PASSWORD_POLICY"),
            submit: t("AUTH_UI.RESET_SUBMIT"),
          }}
        />
      ) : (
        <FormAlert tone="danger">{t("AUTH_UI.RESET_LINK_INVALID")}</FormAlert>
      )}
    </>
  );
}
