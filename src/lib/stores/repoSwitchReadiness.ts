/**
 * Readiness gate for backend project switches.
 *
 * Most list IPC commands (`list_worktrees`, `list_tags`, `stash_entries`, …)
 * resolve against the Rust-side *active project*. `switch_project` only flips
 * that pointer after the incoming repo finishes loading (graph build, status,
 * watcher), while the frontend flips `activeTabIndex` synchronously and
 * remounts the incoming project's remembered view in the same tick. A view's
 * on-mount fetch can therefore reach the backend while the PREVIOUS project
 * is still active and display its data — the A → B → A "worktree list shows
 * B's entries" bug.
 *
 * `trackRepoSwitch` is called the moment `switch_project` is invoked;
 * repo-scoped refresh functions `await whenRepoSwitchSettled()` BEFORE
 * capturing their fetch-guard token and issuing IPC, so the request always
 * reads the project the view belongs to. Combined with the per-store fetch
 * guards (invalidated on leave), a refresh whose project was left in the
 * meantime still cannot write into the store.
 */

/** Settles when the in-flight backend `switch_project` completes (never rejects). */
let settled: Promise<void> = Promise.resolve();

/**
 * Track the in-flight backend switch. Must be called synchronously when
 * `switch_project` is invoked — before the microtask flush that remounts the
 * incoming project's views — so those views gate on THIS switch, not the
 * previous (already-settled) one.
 */
export function trackRepoSwitch(switchPromise: Promise<unknown>): void {
  settled = switchPromise.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Resolves once the backend has finished switching to the active project
 * (or immediately when no switch is in flight). A rejection of the tracked
 * switch still resolves — the follow-up IPC then fails on its own and the
 * store falls back, same as before.
 *
 * Stability loop: if a NEWER switch starts while we await an older one
 * (A → B → A toggling), keep waiting for the newest — otherwise the
 * follow-up IPC could still land mid-switch and read the wrong repo. A
 * switch that starts after this returns is handled by the per-store fetch
 * guard: the leave-clear invalidates the response.
 */
export async function whenRepoSwitchSettled(): Promise<void> {
  let p = settled;
  do {
    await p;
    p = settled;
  } while (p !== settled);
}
