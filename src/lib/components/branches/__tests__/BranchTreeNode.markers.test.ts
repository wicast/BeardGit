/**
 * The branch tree must visually distinguish the actually checked-out branch
 * (`isHead`) from a different local branch that merely points at the same
 * commit (`atHead`). Regression: both used to render the solid "current
 * branch" dot because HEAD was matched by tip OID, so the two were
 * indistinguishable.
 */
import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import BranchTreeNode from "../BranchTreeNode.svelte";
import type { BranchTreeNode as TreeNode } from "../branch-tree";

function leaf(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    name: "dev",
    fullPath: "dev",
    isFolder: false,
    isHead: false,
    atHead: false,
    isRemote: false,
    oid: "9986c79".padEnd(40, "0"),
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    children: [],
    ...overrides,
  };
}

function renderLeaf(node: TreeNode) {
  return render(BranchTreeNode, {
    props: {
      node,
      depth: 0,
      selected: null,
      onSelect: () => {},
      onContext: () => {},
    },
  });
}

describe("BranchTreeNode head markers", () => {
  it("checked-out branch gets the solid current-branch dot only", () => {
    const { container } = renderLeaf(leaf({ name: "lookdev", fullPath: "lookdev", isHead: true }));
    expect(container.querySelector(".head-dot")).not.toBeNull();
    expect(container.querySelector(".same-head-dot")).toBeNull();
    cleanup();
  });

  it("same-commit branch gets the hollow marker only", () => {
    const { container } = renderLeaf(leaf({ name: "dev", fullPath: "dev", atHead: true }));
    expect(container.querySelector(".same-head-dot")).not.toBeNull();
    expect(container.querySelector(".head-dot")).toBeNull();
    cleanup();
  });

  it("unrelated branch gets neither marker", () => {
    const { container } = renderLeaf(
      leaf({ name: "feature/x", fullPath: "feature/x", oid: "aaa".padEnd(40, "0") }),
    );
    expect(container.querySelector(".head-dot")).toBeNull();
    expect(container.querySelector(".same-head-dot")).toBeNull();
    cleanup();
  });
});
