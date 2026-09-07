import { logoutAction } from "@/app/(auth)/actions";
import { t } from "@/lib/labels";

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <button type="submit" className="text-sm text-ink-600 hover:text-ink-900 px-2 py-1">
        {t("nav.logout")}
      </button>
    </form>
  );
}
