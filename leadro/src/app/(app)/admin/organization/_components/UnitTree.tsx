import { cx } from "@/components/ui";
import type { TranslateFn } from "@/lib/i18n";
import type { TreeNode } from "../../_lib/unit-tree";
import type { UnitSummary } from "../../_lib/options";

export interface UnitTreeProps {
  t: TranslateFn;
  nodes: Array<TreeNode<UnitSummary>>;
  selectedId: string | undefined;
  /** Builds the link of a node (keeps the current search). */
  hrefFor: (unitId: string) => string;
}

function Branch({ t, node, selectedId, hrefFor }: Omit<UnitTreeProps, "nodes"> & { node: TreeNode<UnitSummary> }) {
  const isSelected = node.unit.id === selectedId;
  return (
    <li>
      <a
        href={hrefFor(node.unit.id)}
        aria-current={isSelected ? "true" : undefined}
        className={cx(
          "flex flex-wrap items-baseline gap-2 rounded px-2 py-1 text-sm hover:bg-neutral-soft",
          isSelected && "bg-brand-50 font-semibold text-brand-700",
        )}
      >
        <span>{node.unit.name}</span>
        <span className="text-xs text-ink-muted">{t(`ORG_UNIT_TYPE.${node.unit.type}`)}</span>
        {node.unit.code ? (
          <span className="text-xs text-ink-muted" dir="ltr">
            {node.unit.code}
          </span>
        ) : null}
      </a>
      {node.children.length > 0 ? (
        <ul className="ms-4 border-s border-line ps-2">
          {node.children.map((child) => (
            <Branch key={child.unit.id} t={t} node={child} selectedId={selectedId} hrefFor={hrefFor} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The org tree as nested links; each node opens its detail panel via `?unit=`. */
export function UnitTree({ t, nodes, selectedId, hrefFor }: UnitTreeProps) {
  return (
    <ul aria-label={t("ADMIN.ORG_TREE_LABEL")} className="space-y-0.5">
      {nodes.map((node) => (
        <Branch key={node.unit.id} t={t} node={node} selectedId={selectedId} hrefFor={hrefFor} />
      ))}
    </ul>
  );
}
