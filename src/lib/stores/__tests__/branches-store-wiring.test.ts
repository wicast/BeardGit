/**
 * Regression: "切回 All branches 后再也换不了分支" (after switching back to
 * All branches, the dropdown shows no branch options, trapping the user).
 *
 * Root cause: `src/lib/stores/projects.ts` imported the `branches` store
 * from `./repo` (legacy `writable<BranchInfo[]>([])`) instead of from
 * `./branches` (the `activeField` facade over `RepoState.branches.list`).
 * `GitGraph.svelte` reads from `./branches`, so the legacy writes were
 * invisible to the graph → `scopeBranches` was always empty → the dropdown
 * rendered only the hardcoded "All branches" entry.
 *
 * These tests lock the wiring so the regression cannot silently come back.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { branches as branchesFacade } from "../branches";
import { branches as legacyBranches } from "../repo";
import {
  __resetRepoStateForTests,
  createRepoState,
  setActiveRepoPath,
  getActiveRepoState,
} from "../repo-state";
import type { BranchInfo } from "$lib/types";

const fakeBranches: BranchInfo[] = [
  {
    name: "main",
    is_head: true,
    is_remote: false,
    oid: "a".repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    upstream_gone: false,
  },
  {
    name: "develop",
    is_head: false,
    is_remote: false,
    oid: "b".repeat(40),
    upstream: "origin/develop",
    ahead: 1,
    behind: 0,
    upstream_gone: false,
  },
];

describe("branches store wiring (graph dropdown regression)", () => {
  beforeEach(() => __resetRepoStateForTests());

  it("branches facade from $lib/stores/branches writes to the active RepoState", () => {
    createRepoState("/fake/repo");
    setActiveRepoPath("/fake/repo");
    branchesFacade.set(fakeBranches);
    // Graph reads via this same facade → must reflect the set.
    expect(get(branchesFacade)).toEqual(fakeBranches);
    // And it must have landed in the active repo's slice, not somewhere else.
    expect(get(getActiveRepoState().branches.list)).toEqual(fakeBranches);
  });

  it("branches facade and legacy ./repo branches store are distinct", () => {
    createRepoState("/fake/repo");
    setActiveRepoPath("/fake/repo");
    branchesFacade.set(fakeBranches);
    // The legacy store is NOT what the graph reads; writing through the
    // facade must not leak into it.
    expect(get(legacyBranches)).toEqual([]);
  });

  it("activeField isolates branches per repo across tab switches", () => {
    createRepoState("/repoA");
    createRepoState("/repoB");
    setActiveRepoPath("/repoA");
    branchesFacade.set(fakeBranches);
    setActiveRepoPath("/repoB");
    expect(get(branchesFacade)).toEqual([]);
    setActiveRepoPath("/repoA");
    expect(get(branchesFacade)).toEqual(fakeBranches);
  });
});

describe("projects.ts must import branches from the RepoState facade", () => {
  // Read the source statically and assert the legacy `./repo` import does
  // not bring `branches` along. If anyone re-adds it, GitGraph's dropdown
  // silently empties and the user is stuck on "All branches".
  const here = dirname(fileURLToPath(import.meta.url));
  const projectsTs = readFileSync(resolve(here, "../projects.ts"), "utf-8");

  it('does not import `branches` from "./repo"', () => {
    const legacyImportLine = projectsTs
      .split("\n")
      .find((line) => /from ["']\.\/repo["']/.test(line));
    expect(legacyImportLine, "expected an `import … from \"./repo\"` line").toBeDefined();
    expect(legacyImportLine!).not.toMatch(/\bbranches\b/);
  });

  it('imports `branches` from "./branches" (the RepoState facade)', () => {
    const facadeImportLine = projectsTs
      .split("\n")
      .find((line) => /from ["']\.\/branches["']/.test(line));
    expect(facadeImportLine, "expected an `import … from \"./branches\"` line").toBeDefined();
    expect(facadeImportLine!).toMatch(/\bbranches\b/);
  });
});