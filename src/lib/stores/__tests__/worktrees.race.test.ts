/**
 * Regression: A → worktrees → B → quickly back to A must show A's list,
 * not B's late IPC response.
 *
 * The module-level worktrees store is cleared on leave; an in-flight
 * `list_worktrees` from the previous project must not write after clear.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/api/tauri", () => ({
  listWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  aiListWorktrees: vi.fn().mockResolvedValue([]),
  aiCleanupWorktree: vi.fn(),
}));

import { listWorktrees } from "$lib/api/tauri";
import { worktrees, worktreeLoading, refreshWorktrees, clearWorktreeState } from "../worktrees";
import { trackRepoSwitch } from "../repoSwitchReadiness";
import type { WorktreeInfo } from "$lib/types";

function wt(path: string, branch: string): WorktreeInfo {
  return { path, branch, head_oid: "abc", is_main: false, is_locked: false };
}

describe("worktrees project-switch race", () => {
  beforeEach(() => {
    clearWorktreeState();
    // No backend switch in flight unless a test tracks one.
    trackRepoSwitch(Promise.resolve());
    vi.mocked(listWorktrees).mockReset();
    vi.mocked(listWorktrees).mockResolvedValue([]);
  });

  it("discards B's late response after switching back to A", async () => {
    let resolveB!: (v: WorktreeInfo[]) => void;
    const bResponse = new Promise<WorktreeInfo[]>((r) => { resolveB = r; });

    // A's list is already shown.
    vi.mocked(listWorktrees).mockResolvedValueOnce([wt("/A/.worktrees/feat", "feat")]);
    await refreshWorktrees();
    expect(get(worktrees)).toHaveLength(1);
    expect(get(worktrees)[0].path).toContain("/A/");

    // Switch to B: leave-clear invalidates A's store; B's fetch is slow.
    clearWorktreeState();
    vi.mocked(listWorktrees).mockReturnValueOnce(bResponse);
    const bFetch = refreshWorktrees();

    // Quickly switch back to A: leave-clear invalidates B's in-flight fetch.
    clearWorktreeState();
    vi.mocked(listWorktrees).mockResolvedValueOnce([wt("/A/.worktrees/feat", "feat")]);
    await refreshWorktrees();

    // B's response arrives late — must not overwrite A.
    resolveB([wt("/B/.worktrees/other", "other")]);
    await bFetch;

    expect(get(worktrees)).toHaveLength(1);
    expect(get(worktrees)[0].path).toContain("/A/");
    expect(get(worktreeLoading)).toBe(false);
  });

  it("defers the fetch until an in-flight backend switch settles", async () => {
    // Regression for the A→B→A wrong-list bug: switching back to A
    // remounts the worktrees view in the same tick that fires
    // `switch_project`; the Rust-side active project flips only when that
    // command finishes, so an immediate `list_worktrees` would read B.
    let resolveSwitch!: () => void;
    trackRepoSwitch(new Promise<void>((r) => { resolveSwitch = r; }));

    vi.mocked(listWorktrees).mockResolvedValue([wt("/A/.worktrees/feat", "feat")]);
    const p = refreshWorktrees();

    // Spinner is up while we wait — no empty-state flash.
    expect(get(worktreeLoading)).toBe(true);
    // Flush microtasks: the IPC must NOT have gone out mid-switch.
    await Promise.resolve();
    expect(listWorktrees).not.toHaveBeenCalled();

    resolveSwitch();
    await p;
    expect(listWorktrees).toHaveBeenCalledTimes(1);
    expect(get(worktrees)[0].path).toContain("/A/");
    expect(get(worktreeLoading)).toBe(false);
  });

  it("keeps waiting when a newer switch starts mid-wait (A→B→A)", async () => {
    let resolveB!: () => void;
    let resolveA2!: () => void;
    trackRepoSwitch(new Promise<void>((r) => { resolveB = r; }));

    vi.mocked(listWorktrees).mockResolvedValue([wt("/A/.worktrees/feat", "feat")]);
    const p = refreshWorktrees();

    // While B's switch is still pending, the user toggles back to A:
    // the leave-clear runs and a second switch is tracked.
    clearWorktreeState();
    trackRepoSwitch(new Promise<void>((r) => { resolveA2 = r; }));

    // B's switch settling must NOT release the fetch — A's is in flight.
    resolveB();
    await Promise.resolve();
    await Promise.resolve();
    expect(listWorktrees).not.toHaveBeenCalled();

    resolveA2();
    await p;
    expect(listWorktrees).toHaveBeenCalledTimes(1);
    expect(get(worktrees)[0].path).toContain("/A/");
  });
});
