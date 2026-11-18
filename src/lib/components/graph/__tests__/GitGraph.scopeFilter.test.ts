/**
 * Filter rules for the graph's branch scope picker.
 *
 * `GitGraph.svelte` paints to a canvas and cannot be mounted under jsdom, so
 * the picker's filtering lives in `GitGraph.helpers.ts` and is tested here —
 * the same split the create-branch handoff uses.
 */

import { describe, it, expect } from "vitest";
import { filterScopeBranches } from "../GitGraph.helpers";

/** Shaped like a repo whose branch list is long enough to need this box. */
const BRANCHES = [
  { name: "feat/lookdev", is_head: true },
  { name: "backup/assets-relocation-orphan", is_head: false },
  { name: "backup/codex-v2-reorder-20261111-233300", is_head: false },
  { name: "backup/feat-codex-v2-20261105", is_head: false },
  { name: "bak", is_head: false },
  { name: "BTEditor", is_head: false },
  { name: "chore/asset-rules-adj", is_head: false },
];

const names = (query: string) => filterScopeBranches(BRANCHES, query).map((b) => b.name);

describe("filterScopeBranches", () => {
  it("hands back the caller's list untouched for an empty query", () => {
    // Identity, not just equality: the picker sorts the current branch to the
    // top before filtering, and an empty box must not disturb that.
    expect(filterScopeBranches(BRANCHES, "")).toBe(BRANCHES);
    expect(filterScopeBranches(BRANCHES, "   ")).toBe(BRANCHES);
  });

  it("matches case-insensitively", () => {
    expect(names("LOOKDEV")).toEqual(["feat/lookdev"]);
    expect(names("bteditor")).toEqual(["BTEditor"]);
    expect(names("BTEDITOR")).toEqual(["BTEditor"]);
  });

  it("matches a fragment inside a namespaced name", () => {
    expect(names("codex-v2")).toEqual([
      "backup/codex-v2-reorder-20261111-233300",
      "backup/feat-codex-v2-20261105",
    ]);
    expect(names("20261111")).toEqual(["backup/codex-v2-reorder-20261111-233300"]);
  });

  it("keeps the caller's order rather than re-sorting matches", () => {
    expect(names("a")).toEqual([
      "feat/lookdev",
      "backup/assets-relocation-orphan",
      "backup/codex-v2-reorder-20261111-233300",
      "backup/feat-codex-v2-20261105",
      "bak",
      "chore/asset-rules-adj",
    ]);
  });

  it("returns nothing for a query no branch satisfies", () => {
    expect(names("release/")).toEqual([]);
  });

  it("trims the query so trailing space does not hide every branch", () => {
    // Untrimmed, `"bak "` matches nothing — no branch name ends in a space.
    expect(names("bak ")).toEqual(["bak"]);
  });
});
