/**
 * Slow-operation tracking — one entry point for "a git op is still running".
 *
 * Git write commands run on the main process against the working tree, and
 * on a large repo a `discard` or `commit` can sit in IO for tens of seconds.
 * The renderer's only signal used to be the completion toast from
 * {@link runMutation}, so during the wait the UI looked hung. Every UI-initiated
 * mutation registers here for its project, and a `BusyDialog` surfaces the
 * batch once it has been running long enough to be worth interrupting the
 * user about.
 *
 * Two deliberate choices:
 *
 *   - **The threshold lives here, not in the dialog.** Registration arms a
 *     timer per op; the dialog only ever reads a boolean. A fast operation
 *     therefore never paints a modal for one frame — it finishes before its
 *     timer fires and the timer gets cleared.
 *
 *   - **State is keyed by project path** (see `repo-state/BusySlice`), captured
 *     by the caller at *invoke* time rather than read from the active tab at
 *     completion time. Without that, starting a checkout in repo A, switching
 *     to repo B, and letting A finish would have marked B busy.
 *
 * Two things must hold for a mutation to raise the notice, and this set is
 * only the first: its `kind` is listed below, **and** it is not tracked as a
 * task (`runMutation`'s `trackAsTask`). Anything in the status-bar Tasks slot
 * already has a live indicator, so fetch / pull / push / rebase are out on the
 * second rule regardless of kind — one operation, one progress surface. The
 * first rule is what keeps the HTTP requests panel, AI sessions and forge
 * (MR/PR/release) calls out: `runMutation` is shared with them, they are
 * network-bound, and a new local git command has to be added here to be
 * covered.
 */

import { derived, get, type Readable, type Writable } from "svelte/store";
import { activeField, getRepoState, type BusyOp } from "./repo-state";

export type { BusyOp };

/** How long a mutation must be in flight before the dialog appears. */
export const SLOW_OP_MS = 3000;

/**
 * Local, IO-bound git/workspace mutations worth a "still working" notice.
 * Rule one of two: a kind listed here is still skipped when its call site
 * tracks the op as a task, because the status-bar slot covers it already.
 */
const GIT_MUTATION_KINDS: ReadonlySet<string> = new Set([
  "stage",
  "unstage",
  "commit",
  "discard",
  "clean",
  "gitignore_add",
  "checkout",
  "checkout_detached",
  "branch_create",
  "branch_rename",
  "branch_delete",
  "branch_delete_batch",
  "merge",
  "rebase",
  "revert",
  "cherry_pick",
  "reset_soft",
  "reset_mixed",
  "reset_hard",
  "stash_push",
  "stash_apply",
  "stash_apply_file",
  "stash_pop",
  "stash_drop",
  "tag_create",
  "tag_delete",
  "worktree_create",
  "worktree_remove",
  "worktree_cleanup_ai",
  "worktree_lock",
  "worktree_unlock",
  "patch_apply",
  "patch_create",
  "resolve_conflict",
  "abort_operation",
  "continue_operation",
  "bisect_step",
  "bisect_reset",
  "submodule_init",
  "submodule_deinit",
  "submodule_remove",
  "editor_save",
  "editor_save_and_stage",
  "editor_create_path",
  "editor_rename_path",
  "editor_delete_path",
]);

/** Whether `kind` should get a slow-operation notice. */
export function isSlowOpKind(kind: string): boolean {
  return GIT_MUTATION_KINDS.has(kind);
}

let nextOpId = 0;
/** Pending threshold timers, keyed by op id so {@link endBusy} can cancel. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Mark `kind` as in flight on `path`. Returns the handle for
 * {@link endBusy}, or `null` when there is nothing to track (no project —
 * a terminal tab or the welcome screen — or a tab that has since closed).
 */
export function beginBusy(path: string | null, kind: string): number | null {
  if (!path) return null;
  const busy = getRepoState(path)?.busy;
  if (!busy) return null;

  const op: BusyOp = { id: ++nextOpId, kind, startedAt: Date.now() };
  busy.ops.update((ops) => [...ops, op]);

  const id = op.id;
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      // Re-resolve: the tab may have closed while the timer was pending, and
      // the op may have finished without a matching endBusy (never in practice,
      // but the timer is the last chance to observe that).
      const slice = getRepoState(path)?.busy;
      if (!slice) return;
      if (!get(slice.ops).some((o) => o.id === id)) return;
      slice.notice.set(true);
    }, SLOW_OP_MS),
  );
  return id;
}

/** Retire an op from {@link beginBusy}; clears the notice once a repo drains. */
export function endBusy(path: string | null, id: number | null): void {
  if (id == null) return;
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!path) return;
  const busy = getRepoState(path)?.busy;
  if (!busy) return;
  const remaining = get(busy.ops).filter((o) => o.id !== id);
  busy.ops.set(remaining);
  // `muted` resets with the batch, not per op: hiding a running checkout stays
  // out of the way until every op in that batch is gone, then a fresh op can
  // ask again.
  if (remaining.length === 0) {
    busy.notice.set(false);
    busy.muted.set(false);
  }
}

/** Run `fn` with slow-op tracking for `kind` on `path`. */
export async function withBusyNotice<T>(
  path: string | null,
  kind: string,
  fn: () => Promise<T>,
): Promise<T> {
  const id = beginBusy(path, kind);
  try {
    return await fn();
  } finally {
    endBusy(path, id);
  }
}

// The three facades below are `Writable` rather than `Readable` because that
// is what `activeField` hands back: `busyOps` itself is the only writer in
// production (via `beginBusy`/`endBusy`/`hideBusyNotice`), and the test seam
// resets them through the same facade.
/** Ops in flight on the *active* repo (empty when a terminal tab is focused). */
export const activeBusyOps: Writable<BusyOp[]> = activeField((rs) => rs.busy.ops);
/** True while an op on the active repo has passed {@link SLOW_OP_MS}. */
export const activeBusyNotice: Writable<boolean> = activeField((rs) => rs.busy.notice);
/** True while the user has dismissed the active repo's notice. */
export const activeBusyMuted: Writable<boolean> = activeField((rs) => rs.busy.muted);

/** Whether the busy dialog should be on screen for the active repo. */
export const busyDialogVisible: Readable<boolean> = derived(
  [activeBusyNotice, activeBusyMuted],
  ([$notice, $muted]) => $notice && !$muted,
);

/** Stop showing the notice for the active repo until its ops all drain. */
export function hideBusyNotice(): void {
  // `activeField` facades route writes to the *active* RepoState's slice, so
  // this mutes exactly the repo whose dialog is on screen.
  activeBusyMuted.set(true);
}

/** Test seam — drop pending timers and reset the active repo's slice. */
export function __resetBusyForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  nextOpId = 0;
  activeBusyOps.set([]);
  activeBusyNotice.set(false);
  activeBusyMuted.set(false);
}
