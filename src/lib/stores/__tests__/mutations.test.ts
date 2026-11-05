/**
 * Unit tests for the mutation dispatcher.
 *
 * The rAF coalescer is stubbed to run synchronously so tests stay
 * deterministic. The Tauri `listen` API is mocked to capture the
 * handler and invoke it directly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Use `vi.hoisted` so these stubs are available inside the hoisted
// `vi.mock` factories without tripping TDZ.
const {
  listenMock,
  refreshAndReloadGraph,
  syncGraphScopeWithHead,
  refreshStatuses,
  refreshDiffs,
  refreshBranches,
  refreshTags,
  loadReflog,
  refreshRepoInfo,
  saveCurrentSnapshot,
} = vi.hoisted(() => ({
  listenMock: vi.fn(),
  refreshAndReloadGraph: vi.fn(),
  // Defaults to "the scope did not follow HEAD", so the dispatcher falls
  // through to `refreshAndReloadGraph` — the path these tests assert on.
  syncGraphScopeWithHead: vi.fn(async () => false),
  refreshStatuses: vi.fn(),
  refreshDiffs: vi.fn(),
  refreshBranches: vi.fn(),
  refreshTags: vi.fn(),
  loadReflog: vi.fn(),
  refreshRepoInfo: vi.fn(async () => {}),
  saveCurrentSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));
vi.mock("../graph", () => ({ refreshAndReloadGraph, syncGraphScopeWithHead }));
vi.mock("../changes", () => ({ refreshStatuses, refreshDiffs }));
vi.mock("../branches", () => ({ refreshBranches }));
vi.mock("../tags", () => ({ refreshTags }));
vi.mock("../reflog", () => ({ loadReflog }));
vi.mock("../repo", () => ({ refreshRepoInfo, repoInfo }));
vi.mock("../project-cache", () => ({ saveCurrentSnapshot }));

// Activate project is the tab-switch gate. `vi.hoisted` dodges the
// `vi.mock` hoisting TDZ.
const { activeProject, refreshActiveTitleBar } = vi.hoisted(() => {
  // Minimal writable store stand-in. Imported lazily so it ends up
  // inside the hoisted block without pulling `svelte/store` to the top.
  let value: { path: string } | null = { path: "/repo" };
  const subs = new Set<(v: { path: string } | null) => void>();
  return {
    activeProject: {
      subscribe(fn: (v: { path: string } | null) => void) {
        fn(value);
        subs.add(fn);
        return () => subs.delete(fn);
      },
      set(v: { path: string } | null) {
        value = v;
        for (const fn of subs) fn(value);
      },
    },
    refreshActiveTitleBar: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../projects", () => ({ activeProject, refreshActiveTitleBar }));

// Minimal writable stand-in for `repoInfo`. The dispatcher reads
// `head_branch` before and after refreshing it, to decide whether the graph's
// branch scope was tracking HEAD. Lives in a `vi.hoisted` block so the
// `vi.mock("../repo")` factory above can close over it without a TDZ error.
const { repoInfo } = vi.hoisted(() => {
  let value: { head_branch?: string | null } | null = { head_branch: "main" };
  const subs = new Set<(v: unknown) => void>();
  return {
    repoInfo: {
      subscribe(fn: (v: unknown) => void) {
        fn(value);
        subs.add(fn);
        return () => subs.delete(fn);
      },
      set(v: { head_branch?: string | null } | null) {
        value = v;
        for (const fn of subs) fn(value);
      },
    },
  };
});

import {
  startMutationListener,
  flushPendingForActiveProject,
  __resetForTests,
} from "../mutations";

/**
 * Let the dispatcher's async graph path run to completion.
 *
 * The graph refresh is no longer a single synchronous call: it reads the old
 * head, awaits the repoInfo refresh, then decides whether the branch scope
 * followed HEAD before reloading. Tests asserting on those calls need the
 * microtask queue drained first.
 */
async function flushAsync() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  __resetForTests();
  listenMock.mockReset();
  refreshAndReloadGraph.mockReset();
  syncGraphScopeWithHead.mockReset();
  syncGraphScopeWithHead.mockResolvedValue(false);
  refreshStatuses.mockReset();
  refreshDiffs.mockReset();
  refreshBranches.mockReset();
  refreshTags.mockReset();
  loadReflog.mockReset();
  refreshRepoInfo.mockReset();
  refreshRepoInfo.mockResolvedValue(undefined);
  saveCurrentSnapshot.mockReset();
  saveCurrentSnapshot.mockResolvedValue(undefined);
  refreshActiveTitleBar.mockReset();
  refreshActiveTitleBar.mockResolvedValue(undefined);
  activeProject.set({ path: "/repo" });
  repoInfo.set({ head_branch: "main" });
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

describe("startMutationListener", () => {
  it("dispatches graph refresh when refs_changed flag set", async () => {
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_name, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });

    await startMutationListener();
    expect(listenMock).toHaveBeenCalledWith(
      "project-mutated",
      expect.any(Function),
    );

    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "commit" },
        flags: {
          refs_changed: true,
          head_changed: true,
          status_changed: true,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });

    await flushAsync();

    expect(refreshAndReloadGraph).toHaveBeenCalledTimes(1);
    expect(refreshStatuses).toHaveBeenCalledTimes(1);
    // The Changes view resolves its diff panel from the staged/unstaged
    // FileDiff stores; status changes must refresh them alongside the
    // statuses or clicking a file finds no diff (stale-store regression).
    expect(refreshDiffs).toHaveBeenCalledTimes(1);
    // Branch list mirrors `refs/**`, so refs_changed must trigger a
    // branch-list refresh too — without this, deleted branches stay in
    // the sidebar until the user refreshes manually.
    expect(refreshBranches).toHaveBeenCalledTimes(1);
  });

  it("refreshes diffs alongside statuses on status_changed only", async () => {
    // External stage/unstage (`git add` from a terminal) flips only
    // status_changed. Both the file list AND the diff stores must
    // refresh — the diff panel reads FileDiff entries by path.
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "external" },
        flags: {
          refs_changed: false,
          head_changed: false,
          status_changed: true,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });
    expect(refreshStatuses).toHaveBeenCalledTimes(1);
    expect(refreshDiffs).toHaveBeenCalledTimes(1);
  });

  it("refreshes branches/graph/reflog/repoInfo on head_changed without refs_changed", async () => {
    // A checkout to an EXISTING branch moves only the symbolic HEAD, so the
    // snapshot diff yields head_changed=true, refs_changed=false. The branch
    // list, graph HEAD marker, reflog, and repoInfo must still refresh.
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_name, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    await startMutationListener();

    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "checkout" },
        flags: {
          refs_changed: false,
          head_changed: true,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });

    await flushAsync();

    expect(refreshBranches).toHaveBeenCalledTimes(1);
    expect(refreshAndReloadGraph).toHaveBeenCalledTimes(1);
    expect(loadReflog).toHaveBeenCalledTimes(1);
    expect(refreshRepoInfo).toHaveBeenCalledTimes(1);
    // Tags only change on refs_changed, so a plain checkout must not refetch them.
    expect(refreshTags).not.toHaveBeenCalled();
  });

  it("skips the plain graph reload when the branch scope followed HEAD", async () => {
    // The scope was pinned to the branch we just left, so following HEAD
    // already reloaded the viewport from the top. Issuing a second reload
    // would race two viewport fetches for one checkout.
    syncGraphScopeWithHead.mockResolvedValueOnce(true);
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "checkout" },
        flags: {
          refs_changed: false,
          head_changed: true,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });

    await flushAsync();
    expect(syncGraphScopeWithHead).toHaveBeenCalledTimes(1);
    expect(refreshAndReloadGraph).not.toHaveBeenCalled();
  });

  it("passes the pre-refresh head to the scope sync", async () => {
    // The sync has to see which branch we were ON before repoInfo is
    // overwritten — that is the whole basis of "was tracking HEAD".
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    refreshRepoInfo.mockImplementationOnce(async () => {
      repoInfo.set({ head_branch: "dev" });
    });
    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "checkout" },
        flags: {
          refs_changed: false,
          head_changed: true,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });

    await flushAsync();
    expect(syncGraphScopeWithHead).toHaveBeenCalledWith("main", "dev");
  });

  it("buffers events for inactive projects", async () => {
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    activeProject.set({ path: "/other" });

    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "commit" },
        flags: {
          refs_changed: true,
          head_changed: false,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });

    expect(refreshAndReloadGraph).not.toHaveBeenCalled();

    // Replay on switch.
    flushPendingForActiveProject("/repo");
    await flushAsync();
    expect(refreshAndReloadGraph).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid events within one frame", async () => {
    // Scope a deferred rAF stub to this test only so emits queue up
    // instead of flushing synchronously (the beforeEach stub runs
    // callbacks inline, which would defeat coalescing).
    const rafQueue: Array<() => void> = [];
    const origRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafQueue.push(cb as () => void);
      return 0;
    };

    try {
      let handler: ((ev: unknown) => void) | null = null;
      listenMock.mockImplementation(async (_n, cb) => {
        handler = cb as (ev: unknown) => void;
        return () => {};
      });

      await startMutationListener();
      // Emit 5 refs_changed events in the same tick, no awaits between them.
      for (let i = 0; i < 5; i++) {
        handler!({
          payload: {
            project_path: "/repo",
            kind: { type: "commit" },
            flags: {
              refs_changed: true,
              head_changed: false,
              status_changed: false,
              stashes_changed: false,
              worktrees_changed: false,
              remotes_changed: false,
            },
          },
        });
      }

      // Nothing should have been dispatched yet — the rAF callback is
      // queued, not invoked.
      expect(refreshAndReloadGraph).toHaveBeenCalledTimes(0);

      // Drain the queue — the coalescer should collapse all 5 emits
      // into exactly one dispatch.
      rafQueue.forEach((fn) => fn());
      rafQueue.length = 0;

      await flushAsync();
      expect(refreshAndReloadGraph).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
    }
  });

  it("dispatches stashes / worktrees / remotes refreshers when flagged", async () => {
    const stashesRefresh = vi.fn();
    const worktreesRefresh = vi.fn();
    const remotesRefresh = vi.fn();
    vi.doMock("../stashes", () => ({ refreshStashes: stashesRefresh }));
    vi.doMock("../worktrees", () => ({ refreshWorktrees: worktreesRefresh }));
    vi.doMock("../repoConfig", () => ({ refreshRepoConfig: remotesRefresh }));

    // Reset the module graph so `../mutations` picks up the fresh
    // `vi.doMock` factories above instead of the already-cached
    // real imports from the top-of-file import.
    vi.resetModules();
    const mod = await import("../mutations");
    mod.__resetForTests();
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    await mod.startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "stash" },
        flags: {
          refs_changed: false,
          head_changed: false,
          status_changed: false,
          stashes_changed: true,
          worktrees_changed: true,
          remotes_changed: true,
        },
      },
    });
    expect(stashesRefresh).toHaveBeenCalled();
    expect(worktreesRefresh).toHaveBeenCalled();
    expect(remotesRefresh).toHaveBeenCalled();
  });

  it("refreshes the project-cache snapshot on refs_changed for the active project", async () => {
    // External `git push` produces refs_changed only (the local HEAD oid
    // doesn't move; only refs/remotes/origin/<branch> advances). Without
    // a snapshot save here, the TabTooltip's ahead/behind counts and the
    // OS window title stay stuck on the pre-push values until the user
    // switches projects and back.
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "external" },
        flags: {
          refs_changed: true,
          head_changed: false,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });
    expect(saveCurrentSnapshot).toHaveBeenCalledWith("/repo");
  });

  it("does not save a snapshot for buffered events on inactive projects", async () => {
    // The project is inactive, so the dispatch is buffered. We must not
    // touch the snapshot of an inactive project — saveCurrentSnapshot
    // reads the live `repoInfo` / `fileStatuses` stores which only hold
    // the active project's state.
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    activeProject.set({ path: "/other" });
    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "external" },
        flags: {
          refs_changed: true,
          head_changed: false,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });
    expect(saveCurrentSnapshot).not.toHaveBeenCalled();
    // Replay on tab-switch — saveCurrentSnapshot should fire now.
    flushPendingForActiveProject("/repo");
    expect(saveCurrentSnapshot).toHaveBeenCalledWith("/repo");
  });

  it("refreshes the OS window title alongside the snapshot save", async () => {
    // The title bar's status segment (↑N/↓N/+/!/?/⚑) is rebuilt from
    // the same getStatusSummary the snapshot uses. Without a refresh
    // here it stays stuck on the pre-mutation state until tab-switch.
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "external" },
        flags: {
          refs_changed: true,
          head_changed: false,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: false,
          remotes_changed: false,
        },
      },
    });
    expect(saveCurrentSnapshot).toHaveBeenCalledWith("/repo");
    expect(refreshActiveTitleBar).toHaveBeenCalled();
  });

  it("does not refresh the title when only worktrees_changed fires", async () => {
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "worktree" },
        flags: {
          refs_changed: false,
          head_changed: false,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: true,
          remotes_changed: false,
        },
      },
    });
    expect(refreshActiveTitleBar).not.toHaveBeenCalled();
  });

  it("does not save a snapshot when only worktrees_changed fires", async () => {
    // worktrees_changed doesn't affect any ProjectSnapshot field, so
    // there's no reason to round-trip getStatusSummary on its own.
    let handler: ((ev: unknown) => void) | null = null;
    listenMock.mockImplementation(async (_n, cb) => {
      handler = cb as (ev: unknown) => void;
      return () => {};
    });
    await startMutationListener();
    handler!({
      payload: {
        project_path: "/repo",
        kind: { type: "worktree" },
        flags: {
          refs_changed: false,
          head_changed: false,
          status_changed: false,
          stashes_changed: false,
          worktrees_changed: true,
          remotes_changed: false,
        },
      },
    });
    expect(saveCurrentSnapshot).not.toHaveBeenCalled();
  });
});
