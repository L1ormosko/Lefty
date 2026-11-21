/** A unit as the tree builder needs it (a subset of what `listOrgUnits` returns). */
export interface TreeUnit {
  id: string;
  name: string;
  parentId: string | null;
}

export interface TreeNode<U extends TreeUnit> {
  unit: U;
  children: Array<TreeNode<U>>;
}

/**
 * Arranges a flat unit list into a forest, children sorted by name. A unit whose parent is not in
 * the list (the caller's data scope starts below it, or the parent is archived) becomes a root, so
 * a scoped manager sees their own subtree as a tree instead of nothing. Cycles cannot occur (the
 * service forbids them) but a defensive visited-set keeps a corrupt list from looping forever.
 */
export function buildUnitTree<U extends TreeUnit>(units: readonly U[]): Array<TreeNode<U>> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const childrenOf = new Map<string, U[]>();
  const roots: U[] = [];
  for (const unit of units) {
    if (unit.parentId && byId.has(unit.parentId) && unit.parentId !== unit.id) {
      childrenOf.set(unit.parentId, [...(childrenOf.get(unit.parentId) ?? []), unit]);
    } else {
      roots.push(unit);
    }
  }
  const byName = (a: U, b: U) => a.name.localeCompare(b.name);
  const visited = new Set<string>();
  const build = (unit: U): TreeNode<U> => {
    visited.add(unit.id);
    const children = (childrenOf.get(unit.id) ?? []).filter((child) => !visited.has(child.id)).sort(byName);
    return { unit, children: children.map(build) };
  };
  return roots.sort(byName).map(build);
}

/** Ids of the unit and everything below it, to keep a "move under…" picker from offering a cycle. */
export function subtreeIdsOf<U extends TreeUnit>(units: readonly U[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const unit of units) {
      if (unit.parentId && ids.has(unit.parentId) && !ids.has(unit.id)) {
        ids.add(unit.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Names from the top down to (and including) the unit, for the "reports to" breadcrumb. */
export function pathOf<U extends TreeUnit>(units: readonly U[], unitId: string): string[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let current = byId.get(unitId); current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    names.unshift(current.name);
  }
  return names;
}
