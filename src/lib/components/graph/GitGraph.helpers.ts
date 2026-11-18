/**
 * Pure helpers extracted from `GitGraph.svelte` so they can be unit
 * tested without mounting the canvas component.
 */
import type { InitialSource } from "../branches/suggest-local-name";

/**
 * Wrap a commit OID into the `CreateBranchDialog`'s `InitialSource` shape.
 *
 * Used by the graph's "Create branch at {sha}..." context-menu action to
 * hand off to the shared dialog instead of calling `window.prompt`.
 */
export function buildCreateBranchSource(oid: string): InitialSource {
  return { kind: "commit", oid };
}

/**
 * Decide how the graph should react when the active repo's `RepoInfo`
 * changes. `repoInfo` gets a fresh object on BOTH a real repo switch and a
 * mutation-driven `refreshRepoInfo()`, so keying off object identity yanked
 * the scroll back to row 0 on every background change. Key off the repo
 * *path* instead:
 *
 * - `"none"`    → same repo (mutation refresh, lane-budget tweak) or no repo:
 *                 leave the viewport alone so the mutation reconcile path
 *                 keeps the user's scroll position.
 * - `"restore"` → switched to a repo whose viewport is already in its slice
 *                 (a revisited tab): keep the restored offset + selection from
 *                 the RepoState pointer swap.
 * - `"reset"`   → switched to a repo with no restored viewport (cold start, or
 *                 a genuinely new repo in this tab): load from the top.
 */
export function graphRepoChangeAction(
  prevPath: string | null,
  nextPath: string | null,
  hasViewport: boolean,
): "none" | "restore" | "reset" {
  if (nextPath === null || nextPath === prevPath) return "none";
  return hasViewport ? "restore" : "reset";
}

/**
 * Filter the branch scope picker's list by the search box.
 *
 * Case-insensitive substring on the branch name — the same rule the Branches
 * sidebar applies, so "the thing I type to find a branch" behaves identically
 * in both places. An empty (or whitespace-only) query returns the caller's
 * array untouched: the picker's ordering — current branch first, then
 * alphabetical — is decided by the component and must survive filtering.
 */
export function filterScopeBranches<T extends { name: string }>(
  branches: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return branches;
  return branches.filter((b) => b.name.toLowerCase().includes(needle));
}

/**
 * Decide whether a window-level click should dismiss an open dropdown.
 *
 * The `isConnected` test is the non-obvious half, and it exists because of
 * when Svelte commits. A component event handler flushes its DOM updates
 * before the same click finishes bubbling to the window (`TasksPopover` had
 * to learn this the hard way too). So a control that removes itself in
 * reaction to being clicked — the scope picker's clear button, whose `{#if
 * value}` goes false on the click — is gone by the time the listener asks
 * where the click landed, and `root.contains(target)` answers "outside" for
 * something that was unmistakably inside. Without this guard, clearing the
 * filter closes the whole picker.
 */
export function shouldDismissDropdown(
  root: Node | null | undefined,
  target: EventTarget | null,
): boolean {
  if (!root) return false;
  if (!(target instanceof Node)) return true;
  // Already off the DOM: it removed itself while handling this very click,
  // which means it was inside the menu a moment ago.
  if (!target.isConnected) return false;
  return !root.contains(target);
}
