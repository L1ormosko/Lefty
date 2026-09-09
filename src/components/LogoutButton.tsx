import { logoutAction } from "@/app/(auth)/actions";
import { t } from "@/lib/labels";

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <button type="submit" className="inline-flex items-center min-h-11 sm:min-h-0 sm:py-1 text-sm text-ink-600 hover:text-ink-900 px-2">
        {t("nav.logout")}
      </button>
    </form>
  );
}
