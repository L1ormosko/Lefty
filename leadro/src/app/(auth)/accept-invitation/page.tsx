import { NewPasswordForm } from "../../_components/NewPasswordForm";
import { FormAlert } from "../../_components/FormAlert";
import { getPageContext } from "../../_lib/page-context";
import { acceptInvitationAction } from "./actions";

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await getPageContext();
  const { token } = await searchParams;

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">{t("AUTH_UI.INVITATION_TITLE")}</h1>
      <p className="mb-5 text-sm text-ink-muted">{t("AUTH_UI.INVITATION_INTRO")}</p>
      {token ? (
        <NewPasswordForm
          action={acceptInvitationAction}
          token={token}
          labels={{
            password: t("AUTH.PASSWORD"),
            confirm: t("AUTH_UI.CONFIRM_PASSWORD"),
            policyHint: t("AUTH_UI.PASSWORD_POLICY"),
            submit: t("AUTH_UI.INVITATION_SUBMIT"),
          }}
        />
      ) : (
        <FormAlert tone="danger">{t("AUTH_UI.INVITATION_INVALID")}</FormAlert>
      )}
    </>
  );
}
