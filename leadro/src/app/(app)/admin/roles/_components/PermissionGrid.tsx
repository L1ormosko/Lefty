import type { TranslateFn } from "@/lib/i18n";
import { PERMISSION_ACTIONS, PERMISSION_CATALOG, permissionKey } from "@/server/authz";

/**
 * Permission matrix: one row per module, one column per action; a checkbox exists only where the
 * catalog defines that permission. Ticked boxes are posted as repeated `permission` fields. The grid
 * only toggles permissions; stored conditions of kept grants are preserved by the save action.
 */
export function PermissionGrid({ t, selected, idPrefix }: { t: TranslateFn; selected: ReadonlySet<string>; idPrefix: string }) {
  const modules = [...new Set(PERMISSION_CATALOG.map((def) => def.module))];
  const keys = new Set(PERMISSION_CATALOG.map(permissionKey));
  return (
    <div className="overflow-x-auto rounded border border-line">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t("ADMIN.ROLES_GRID")}</caption>
        <thead className="bg-neutral-soft">
          <tr>
            <th scope="col" className="px-2 py-1 text-start">{t("ADMIN.ROLES_MODULE")}</th>
            {PERMISSION_ACTIONS.map((action) => (
              <th key={action} scope="col" className="px-2 py-1 text-center font-medium">{t(`PERMISSION_ACTION.${action}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {modules.map((module) => (
            <tr key={module} className="border-t border-line">
              <th scope="row" className="px-2 py-1 text-start font-medium" dir="ltr">{module}</th>
              {PERMISSION_ACTIONS.map((action) => {
                const key = `${module}.${action.toLowerCase()}`;
                return (
                  <td key={action} className="px-2 py-1 text-center">
                    {keys.has(key) ? (
                      <input
                        type="checkbox"
                        name="permission"
                        value={key}
                        defaultChecked={selected.has(key)}
                        id={`${idPrefix}-${key}`}
                        aria-label={`${module} ${t(`PERMISSION_ACTION.${action}`)}`}
                        className="h-4 w-4 accent-brand-600"
                      />
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
