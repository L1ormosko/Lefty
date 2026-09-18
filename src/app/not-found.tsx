import Link from "next/link";
import { t } from "@/lib/labels";
import { buttonClass } from "@/components/ui";

/**
 * A page that is not there.
 *
 * Reached by a mistyped URL and, more often, by a link to something that has
 * since been taken down - a listing an owner deactivated, an inquiry on a
 * deleted account. So the copy does not accuse the user of typing it wrong.
 */
export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16 text-center">
      <h1 className="text-xl font-semibold text-ink-900">{t("error.notFoundTitle")}</h1>
      <p className="mt-2 text-ink-600">{t("error.notFoundBody")}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Link href="/explore" className={buttonClass("primary")}>
          {t("nav.explore")}
        </Link>
        <Link href="/" className={buttonClass("secondary")}>
          {t("common.back")}
        </Link>
      </div>
    </main>
  );
}
