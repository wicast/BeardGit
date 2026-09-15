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
import type { WorktreeInfo } from "$lib/types";

function wt(path: string, branch: string): WorktreeInfo {
  return { path, branch, head_oid: "abc", is_main: false, is_locked: false };
}

describe("worktrees project-switch race", () => {
  beforeEach(() => {
    clearWorktreeState();
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
});
