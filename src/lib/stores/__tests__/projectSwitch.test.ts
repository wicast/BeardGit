/**
 * Regression tests for the per-project navigation view-memory choreography.
 *
 * The user-visible bug (F4 / spec 08): switching projects kept the
 * navigation view GLOBALLY instead of restoring each project's own view.
 * Root cause: `switchToTab` mutated `activeTabIndex` BEFORE firing the
 * `onProjectSwitch` callback, so the callback's `get(activeProject)` read
 * the INCOMING tab — the outgoing view was written under the incoming
 * project's key and immediately re-applied.
 *
 * The fix: `onProjectSwitch` now receives `{ prevPath, nextPath }` captured
 * BEFORE the index flips, and every activation path (tab click, keyboard
 * next/prev, close-tab) funnels through it. These tests pin the callback
 * contract so a regression in the prev-capture ordering fails here.
 *
 * Following the repo-state-isolation.test.ts pattern: peripheral stores
 * are mocked to no-ops and git IPC rides the global invoke mock.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { get, writable } from "svelte/store";
import { mockInvokeResponse } from "../../../test/setup";
import type { ProjectInfo, RepoInfo, BranchInfo, TerminalTabInfo } from "$lib/types";

// ── Peripheral stores mocked to no-ops (not under test) ───────────────
vi.mock("$lib/stores/provider", () => ({
  checkStatus: vi.fn(),
  stopAllPolling: vi.fn(),
  ciRuns: writable([]),
  selectedCiRun: writable(null),
  selectedCiRunId: writable(null),
  jobLog: writable(null),
  hasMoreCiRuns: writable(false),
  loadingDetail: writable(false),
  selectedJobId: writable(null),
  jobLogUnavailable: writable(false),
  loadingJobLog: writable(false),
}));
vi.mock("$lib/stores/project-cache", () => ({
  loadProjectSnapshot: vi.fn().mockResolvedValue(null),
  saveCurrentSnapshot: vi.fn().mockResolvedValue(undefined),
  restorePersistedViewport: vi.fn().mockReturnValue(false),
}));
vi.mock("$lib/stores/tags", () => ({ clearTagState: vi.fn(), refreshTags: vi.fn() }));
vi.mock("$lib/stores/stashes", () => ({ clearStashState: vi.fn(), refreshStashes: vi.fn() }));
vi.mock("$lib/stores/blame", () => ({ clearBlameState: vi.fn() }));
vi.mock("$lib/stores/worktrees", () => ({ clearWorktreeState: vi.fn(), refreshWorktrees: vi.fn() }));
vi.mock("$lib/stores/mr-pr", () => ({ clearMrPrState: vi.fn() }));
vi.mock("$lib/stores/issues", () => ({ clearIssueState: vi.fn() }));
vi.mock("$lib/stores/releases", () => ({ clearReleaseState: vi.fn() }));
vi.mock("$lib/stores/reflog", () => ({ clearReflogState: vi.fn(), loadReflog: vi.fn() }));
vi.mock("$lib/stores/conflict", () => ({ refreshConflictStatus: vi.fn() }));
vi.mock("$lib/stores/remotes", () => ({ refreshRemotes: vi.fn() }));
vi.mock("$lib/stores/mutations", () => ({ flushPendingForActiveProject: vi.fn() }));
vi.mock("$lib/stores/initRepoDialog", () => ({
  requestOpenInitRepoDialog: vi.fn(),
  closeInitRepoDialog: vi.fn(),
}));

import {
  switchToTab,
  closeTab,
  switchToNextTab,
  switchToPrevTab,
  onProjectSwitch,
  type ProjectSwitchInfo,
} from "../projects";
import { openTabs, activeTabIndex } from "../tabs";
import { __resetRepoStateForTests, createRepoState, getRepoState } from "../repo-state";

const A: ProjectInfo = {
  name: "repoA", path: "/tmp/A", head_branch: "main", change_count: 0, is_worktree: false,
};
const B: ProjectInfo = {
  name: "repoB", path: "/tmp/B", head_branch: "main", change_count: 0, is_worktree: false,
};

function branch(name: string): BranchInfo {
  return {
    name, is_head: name.endsWith("main"), is_remote: false, oid: "0".repeat(40),
    upstream: null, ahead: 0, behind: 0, upstream_gone: false,
  };
}

const repoInfoByIndex: Record<number, RepoInfo> = {
  0: { path: A.path, head_branch: "main", head_oid: "a".repeat(40), branch_count: 1 },
  1: { path: B.path, head_branch: "main", head_oid: "b".repeat(40), branch_count: 1 },
};

function seedMocks(openProjects: ProjectInfo[]): void {
  mockInvokeResponse("switch_project", (args?: Record<string, unknown>) => {
    const idx = Number(args?.projectIndex ?? args?.project_index ?? 0);
    return repoInfoByIndex[idx];
  });
  mockInvokeResponse("get_open_projects", openProjects);
  mockInvokeResponse("get_branches", [branch("main")]);
  mockInvokeResponse("get_file_statuses", []);
  mockInvokeResponse("get_user_identities", []);
  mockInvokeResponse("get_status_summary", {
    ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, stash_count: 0,
  });
  mockInvokeResponse("detect_project", null);
  mockInvokeResponse("get_remotes", []);
}

/** The spy wired into `onProjectSwitch`, reset per case. */
let switchSpy: ReturnType<typeof vi.fn<(info: ProjectSwitchInfo) => void>>;

describe("project-switch callback — correct prev/next paths (view memory)", () => {
  beforeEach(() => {
    seedMocks([A, B]);
    __resetRepoStateForTests();
    createRepoState(A.path);
    createRepoState(B.path);
    openTabs.set([{ kind: "project", project: A }, { kind: "project", project: B }]);
    activeTabIndex.set(0);
    switchSpy = vi.fn<(info: ProjectSwitchInfo) => void>();
    onProjectSwitch(switchSpy);
  });

  it("switchToTab A→B fires with {prevPath: A, nextPath: B}", async () => {
    await switchToTab(1);
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(switchSpy).toHaveBeenCalledWith({ prevPath: A.path, nextPath: B.path });
  });

  it("switchToTab back B→A fires with {prevPath: B, nextPath: A}", async () => {
    await switchToTab(1);
    switchSpy.mockClear();
    await switchToTab(0);
    expect(switchSpy).toHaveBeenCalledWith({ prevPath: B.path, nextPath: A.path });
  });

  it("first activation (no active tab) fires with {prevPath: null, nextPath: A}", async () => {
    activeTabIndex.set(-1);
    await switchToTab(0);
    expect(switchSpy).toHaveBeenCalledWith({ prevPath: null, nextPath: A.path });
  });

  it("switchToTab to a terminal tab fires with {prevPath: A, nextPath: null}", async () => {
    const term: TerminalTabInfo = { sessionId: 1, title: "term", cwd: "/tmp" };
    openTabs.set([{ kind: "project", project: A }, { kind: "terminal", terminal: term }]);
    await switchToTab(1);
    expect(switchSpy).toHaveBeenCalledWith({ prevPath: A.path, nextPath: null });
  });

  it("closeTab on the ACTIVE project fires with {prevPath: closed A, nextPath: B}", async () => {
    seedMocks([B]); // Rust now reports only B after A closed
    switchSpy.mockClear();
    await closeTab(0);
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(switchSpy).toHaveBeenCalledWith({ prevPath: A.path, nextPath: B.path });
  });

  it("closeTab on an INACTIVE tab does NOT fire the callback (active project unchanged)", async () => {
    // active = A (index 0); closing B (index 1) keeps A active.
    switchSpy.mockClear();
    await closeTab(1);
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it("switchToNextTab fires with {prevPath: A, nextPath: B}", async () => {
    await switchToNextTab();
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(switchSpy).toHaveBeenCalledWith({ prevPath: A.path, nextPath: B.path });
  });

  it("switchToPrevTab fires with {prevPath: B, nextPath: A}", async () => {
    await switchToTab(1);
    switchSpy.mockClear();
    await switchToPrevTab();
    expect(switchSpy).toHaveBeenCalledWith({ prevPath: B.path, nextPath: A.path });
  });

  it("switchToNextTab project → terminal fires {prevPath: A, nextPath: null} (saves outgoing view)", async () => {
    const term: TerminalTabInfo = { sessionId: 2, title: "term2", cwd: "/tmp" };
    openTabs.set([{ kind: "project", project: A }, { kind: "terminal", terminal: term }]);
    activeTabIndex.set(0);
    switchSpy.mockClear();
    await switchToNextTab();
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(switchSpy).toHaveBeenCalledWith({ prevPath: A.path, nextPath: null });
  });

  it("the outgoing view is saved under the OUTGOING project via the real switchToTab path", async () => {
    // Register the +page-style save step as the REAL callback, then drive the
    // real switchToTab. Under the old bug the callback fired with no args
    // (destructuring `info` throws) and prev read the INCOMING tab; with the
    // fix "changes" lands on A's lastView and never leaks into B.
    onProjectSwitch(({ prevPath, nextPath }) => {
      void nextPath;
      if (prevPath) getRepoState(prevPath)?.lastView.set("changes");
    });
    await switchToTab(1); // A → B
    expect(get(getRepoState(A.path)!.lastView)).toBe("changes");
    expect(get(getRepoState(B.path)!.lastView)).toBe("");
  });
});
