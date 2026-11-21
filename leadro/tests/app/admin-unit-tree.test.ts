import { describe, expect, it } from "vitest";
import { buildUnitTree, pathOf, subtreeIdsOf } from "@/app/(app)/admin/_lib/unit-tree";

const unit = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId });

describe("buildUnitTree", () => {
  it("nests children under parents and sorts siblings by name", () => {
    const tree = buildUnitTree([unit("c", "City B", "s"), unit("s", "State"), unit("a", "City A", "s"), unit("t", "Team", "a")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((node) => node.unit.name)).toEqual(["City A", "City B"]);
    expect(tree[0].children[0].children[0].unit.id).toBe("t");
  });

  it("makes a unit whose parent is outside the list a root (scoped managers see their subtree)", () => {
    const tree = buildUnitTree([unit("a", "City A", "hidden-state"), unit("t", "Team", "a")]);
    expect(tree.map((node) => node.unit.id)).toEqual(["a"]);
  });

  it("does not loop on corrupt cyclic data", () => {
    const tree = buildUnitTree([unit("x", "X", "y"), unit("y", "Y", "x")]);
    expect(tree).toEqual([]); // nothing is a root; the point is that it terminates
  });
});

describe("subtreeIdsOf / pathOf", () => {
  const units = [unit("s", "State"), unit("a", "City A", "s"), unit("t", "Team", "a"), unit("b", "City B", "s")];

  it("collects a unit and all its descendants", () => {
    expect([...subtreeIdsOf(units, "a")].sort()).toEqual(["a", "t"]);
  });

  it("returns the names from the top down", () => {
    expect(pathOf(units, "t")).toEqual(["State", "City A", "Team"]);
  });
});
