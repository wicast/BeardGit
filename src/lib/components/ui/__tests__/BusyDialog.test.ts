/**
 * End-to-end check of the slow-operation dialog against a mocked git API.
 *
 * These drive the *real* code path — `stores/changes.commit()` /
 * `runMutation` → `busyOps` → `BusyDialog` — with only the Tauri `invoke`
 * boundary stubbed (see `src/test/setup.ts`), and the stub resolves on a
 * timer so a whole slow operation is simulated without a repository, a
 * `git` binary, or a real window.
 *
 * The behaviours that matter here, and that a unit test on the store alone
 * would not prove:
 *   - nothing is painted until the 3 s threshold (no flash on fast ops);
 *   - the dialog belongs to the project that started the work, so switching
 *     tabs switches it away and back;
 *   - it goes away when the operation settles, including after the user has
 *     chosen "run in background".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import BusyDialog from "../BusyDialog.svelte";
import { mockInvokeResponse } from "../../../../test/setup";
import {
  createRepoState,
  setActiveRepoPath,
  __resetRepoStateForTests,
} from "$lib/stores/repo-state";
import { __resetBusyForTests, activeBusyNotice } from "$lib/stores/busyOps";
import { get } from "svelte/store";
import { commit } from "$lib/stores/changes";
import { discardFiles, pushRemote } from "$lib/api/tauri";
import { runMutation } from "$lib/api/runMutation";

const REPO_A = "D:/repos/alpha";
const REPO_B = "D:/repos/beta";

/** Stub `command` so the invoke settles after `ms` of fake time. */
function stubSlowCommand(command: string, ms: number, result: unknown = undefined): void {
  mockInvokeResponse(command, () => new Promise((resolve) => setTimeout(() => resolve(result), ms)));
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetRepoStateForTests();
  __resetBusyForTests();
  createRepoState(REPO_A);
  createRepoState(REPO_B);
  setActiveRepoPath(REPO_A);
  render(BusyDialog);
});

afterEach(() => {
  cleanup();
  __resetBusyForTests();
  __resetRepoStateForTests();
  vi.useRealTimers();
});

describe("BusyDialog with a mocked slow git operation", () => {
  it("appears at 3s into a slow commit and closes when it lands", async () => {
    stubSlowCommand("create_commit", 5000, "deadbeef");

    const pending = commit("feat: slow thing");

    await vi.advanceTimersByTimeAsync(2_999);
    await tick();
    expect(screen.queryByTestId("bg-busy-dialog")).toBeNull();
    expect(get(activeBusyNotice)).toBe(false);

    await vi.advanceTimersByTimeAsync(5);
    await tick();
    expect(screen.getByTestId("bg-busy-dialog")).toBeTruthy();
    expect(screen.getByTestId("bg-busy-op").textContent).toContain("commit");

    await vi.advanceTimersByTimeAsync(2_100);
    await pending;
    await tick();
    expect(screen.queryByTestId("bg-dialog")).toBeNull();
    expect(get(activeBusyNotice)).toBe(false);
  });

  it("never opens for a commit that finishes inside the threshold", async () => {
    stubSlowCommand("create_commit", 900, "deadbeef");

    const pending = commit("chore: fast thing");
    await vi.advanceTimersByTimeAsync(950);
    await pending;
    await tick();

    expect(screen.queryByTestId("bg-busy-dialog")).toBeNull();
  });

  it("stays with the project that started a slow discard when tabs are switched", async () => {
    stubSlowCommand("discard_files", 8000);

    const pending = runMutation({
      kind: "discard",
      invoke: () => discardFiles(["big/dir/**"]),
      failureToastPrefix: "Discard failed",
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await tick();
    expect(screen.getByTestId("bg-busy-dialog")).toBeTruthy();

    // Repo B is idle: focusing it must clear the notice rather than follow
    // the operation that is still running over in A.
    setActiveRepoPath(REPO_B);
    await tick();
    expect(screen.queryByTestId("bg-dialog")).toBeNull();

    setActiveRepoPath(REPO_A);
    await tick();
    expect(screen.getByTestId("bg-busy-dialog")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(5_100);
    await pending;
    await tick();
    expect(screen.queryByTestId("bg-dialog")).toBeNull();
  });

  it("leaves a backgrounded notice alone until the batch drains", async () => {
    stubSlowCommand("create_commit", 5000, "deadbeef");

    const pending = commit("feat: background me");
    await vi.advanceTimersByTimeAsync(3_000);
    await tick();

    await fireEvent.click(screen.getByTestId("bg-busy-hide"));
    await tick();
    expect(screen.queryByTestId("bg-dialog")).toBeNull();
    // Hidden, but the operation is still registered as in flight.
    expect(get(activeBusyNotice)).toBe(true);

    await vi.advanceTimersByTimeAsync(2_100);
    await pending;
    await tick();
    expect(get(activeBusyNotice)).toBe(false);

    // A fresh slow op is a new batch, so it asks again.
    stubSlowCommand("create_commit", 5000, "abcdef01");
    const next = commit("feat: ask again");
    await vi.advanceTimersByTimeAsync(3_000);
    await tick();
    expect(screen.getByTestId("bg-busy-dialog")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(2_100);
    await next;
  });

  it("does not report a notice for network-backed kinds", async () => {
    stubSlowCommand("push_remote", 5000, 1);

    const pending = runMutation({
      kind: "push",
      invoke: () => pushRemote("origin", "main", false),
      failureToastPrefix: "Push failed",
    });

    await vi.advanceTimersByTimeAsync(4_000);
    await tick();
    expect(get(activeBusyNotice)).toBe(false);
    expect(screen.queryByTestId("bg-busy-dialog")).toBeNull();

    await vi.advanceTimersByTimeAsync(1_100);
    await pending;
  });
});
