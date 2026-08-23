/**
 * Per-project view memory — decides which sidebar view a project reopens
 * on when its tab regains focus.
 *
 * History: every project-tab switch forced the view back to `"graph"`
 * (`+page.svelte`'s `onProjectSwitch` callback), so checking branches on
 * project A, glancing at project B, and returning to A landed you back on
 * the graph. Now each repo records its last view in its `RepoState` slice
 * (`RepoState.lastView`) and restores it on re-activation.
 *
 * Only *repo-scoped* views are remembered. Global surfaces (Settings,
 * forge views that reroute on disconnect anyway) and AI views (which the
 * F1 master switch can disable mid-session) always fall back to graph.
 */

/**
 * Views worth remembering per project. Mirrors the sidebar navigation
 * items plus the `.http` workspace; excludes global/forge/AI/blame views.
 */
export const REMEMBERABLE_VIEWS: ReadonlySet<string> = new Set([
  "graph",
  "changes",
  "editor",
  "branches",
  "tags",
  "stashes",
  "worktrees",
  "reflog",
  "bisect",
  "submodules",
  "requests",
]);

/**
 * Resolve the view to show for an activating project.
 *
 * @param lastView The project's recorded last view (`null` on first visit
 *   or when the repo has no live `RepoState` yet).
 * @returns The remembered view when it is still rememberable, otherwise
 *   `"graph"` (first visit, or the stored view went out of scope — e.g.
 *   the AI master switch turned off between visits).
 */
export function resolveViewOnSwitch(lastView: string | null | undefined): string {
  if (lastView && REMEMBERABLE_VIEWS.has(lastView)) return lastView;
  return "graph";
}
