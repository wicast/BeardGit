/**
 * Per-repo "an operation is still running" state (RepoState slice).
 *
 * A git write op (discard, commit, checkout, stash, …) blocks on a `git`
 * child process or libgit2 work in the main process, and on a big repo that
 * can take tens of seconds with nothing on screen to say so. Callers
 * register an op here when they start and drop it when the invoke settles;
 * `busyOps.ts` owns *when* that becomes visible (the slow-op threshold) and
 * this slice only holds the per-project fact of what is in flight.
 *
 * Living on `RepoState` is what makes the notice project-scoped: each open
 * tab owns its own `BusySlice`, so a long checkout in repo A never dims
 * repo B, and closing a tab frees the entry along with the rest of its state.
 */

import { writable } from "svelte/store";

/** One in-flight mutation. */
export interface BusyOp {
  /** Handle returned to {@link endBusy} — unique process-wide. */
  id: number;
  /** `runMutation`'s `kind` label (`commit`, `discard`, …), for display. */
  kind: string;
  /** `Date.now()` at registration — feeds the elapsed counter. */
  startedAt: number;
}

export class BusySlice {
  /** Mutations currently running against this repo. */
  readonly ops = writable<BusyOp[]>([]);
  /**
   * True once an op has been in flight past the slow-op threshold. Kept
   * separate from `ops` so a fast operation never renders a dialog at all
   * (no flash) — consumers read this rather than `ops.length`.
   */
  readonly notice = writable(false);
  /**
   * True while the user has chosen to let the batch run in the background.
   * Suppresses the dialog until every op drains, so re-showing it is tied to
   * "a genuinely new batch started" rather than to each op finishing.
   */
  readonly muted = writable(false);

  clear(): void {
    this.ops.set([]);
    this.notice.set(false);
    this.muted.set(false);
  }
}
