import { TextInput, Select } from "@/components/ui";
import type { TranslateFn } from "@/lib/i18n";
import { inviteEmployeeAction } from "../employees/actions";
import { ActionDialog } from "./ActionDialog";
import { AdminField } from "./AdminField";
import { ScopeFields } from "./ScopeFields";

type Option = { value: string; label: string };

export interface InviteDialogProps {
  t: TranslateFn;
  /** Fixed employee (profile page) or undefined to let the user pick one (users page). */
  employeeId?: string;
  employeeOptions?: Option[];
  roleOptions: Option[];
  unitOptions: Option[];
  legalEntityOptions: Option[];
  defaultEmail?: string;
  variant?: "primary" | "secondary";
}

/** "Invite to LEADRO" dialog: optional email override, optional role with its mandatory scope. */
export function InviteDialog({ t, employeeId, employeeOptions = [], roleOptions, unitOptions, legalEntityOptions, defaultEmail, variant = "secondary" }: InviteDialogProps) {
  const prefix = `invite-${employeeId ?? "any"}`;
  return (
    <ActionDialog
      triggerLabel={t("ADMIN.INVITE_ACTION")}
      triggerVariant={variant}
      title={t("ADMIN.INVITE_ACTION")}
      description={t("ADMIN.INVITE_HELP")}
      submitLabel={t("ADMIN.INVITE_SEND")}
      cancelLabel={t("COMMON.CANCEL")}
      closeLabel={t("COMMON.CLOSE")}
      action={inviteEmployeeAction}
    >
      {employeeId ? (
        <input type="hidden" name="employeeId" value={employeeId} />
      ) : (
        <AdminField label={t("ADMIN.ORG_EMPLOYEE")} htmlFor={`${prefix}-employee`} required>
          <Select id={`${prefix}-employee`} name="employeeId" options={employeeOptions} placeholder={t("ADMIN.CHOOSE")} required />
        </AdminField>
      )}
      <AdminField label={t("ADMIN.INVITE_EMAIL")} htmlFor={`${prefix}-email`} hint={t("ADMIN.INVITE_EMAIL_HINT")}>
        <TextInput id={`${prefix}-email`} name="email" type="email" defaultValue={defaultEmail} dir="ltr" maxLength={254} />
      </AdminField>
      <AdminField label={t("ADMIN.INVITE_ROLE")} htmlFor={`${prefix}-role`} hint={t("ADMIN.INVITE_ROLE_HINT")}>
        <Select id={`${prefix}-role`} name="roleId" options={roleOptions} placeholder={t("ADMIN.INVITE_NO_ROLE")} />
      </AdminField>
      <ScopeFields t={t} idPrefix={prefix} unitOptions={unitOptions} legalEntityOptions={legalEntityOptions} />
    </ActionDialog>
  );
}
