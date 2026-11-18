/**
 * `runMutation` tests — verify the façade's toast + task policy.
 *
 * The five cases below cover the contract the call-site migrations in
 * Tasks 7.2–7.4 rely on:
 *
 *  1. Success path fires a 5 s auto-dismiss toast and resolves with the
 *     invoke's return value untouched (generic preservation).
 *  2. Failure path fires a sticky (`duration: null`) error toast whose
 *     body carries only the first line of a multi-line error, then
 *     rethrows the original error.
 *  3. Omitting `successToast` suppresses the success toast entirely —
 *     the silent-set ops (stage / unstage / discard) rely on this.
 *  4. `trackAsTask: true` funnels through `taskRunner.begin` and
 *     `taskRunner.complete` so long-ops show up in the Tasks popover.
 *  5. When the mutation is *not* tracked as a task, a failure still
 *     produces an ad-hoc task record so the "See details" toast action
 *     has an entry to open in the drawer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";

// `vi.mock` is hoisted to the top of the file, so the mock factories
// cannot close over module-level `const`s — we use `vi.hoisted` to
// create the spies *before* the mock factories reference them.
const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  begin: vi.fn<(kind: string) => string>().mockReturnValue("task-1"),
  complete: vi.fn(),
  createAdhoc: vi.fn<(kind: string, err: unknown) => string>().mockReturnValue(
    "adhoc-1",
  ),
  openTasksPopover: vi.fn<(id?: string) => void>(),
}));

vi.mock("$lib/stores/toast", () => ({ addToast: mocks.addToast }));
vi.mock("$lib/stores/taskRunner", () => ({
  taskRunner: {
    begin: mocks.begin,
    complete: mocks.complete,
    createAdhoc: mocks.createAdhoc,
  },
}));
vi.mock("$lib/stores/tasksPopover", () => ({
  openTasksPopover: mocks.openTasksPopover,
}));

import { runMutation } from "../runMutation";
import {
  createRepoState,
  getRepoState,
  setActiveRepoPath,
  __resetRepoStateForTests,
} from "$lib/stores/repo-state";
import {
  SLOW_OP_MS,
  activeBusyNotice,
  __resetBusyForTests,
} from "$lib/stores/busyOps";
const { addToast, begin, complete, createAdhoc, openTasksPopover } = mocks;

beforeEach(() => {
  addToast.mockReset();
  begin.mockReset().mockReturnValue("task-1");
  complete.mockReset();
  createAdhoc.mockReset().mockReturnValue("adhoc-1");
  openTasksPopover.mockReset();
});

describe("runMutation", () => {
  it("fires success toast + resolves", async () => {
    const result = await runMutation({
      kind: "commit",
      invoke: async () => "oid",
      successToast: (r) => `Committed — ${r}`,
      failureToastPrefix: "Commit failed",
    });
    expect(result).toBe("oid");
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", message: "Committed — oid" }),
    );
  });

  it("fires sticky failure toast + rethrows", async () => {
    const err = new Error("boom\nsecond line");
    await expect(
      runMutation({
        kind: "push",
        invoke: async () => {
          throw err;
        },
        failureToastPrefix: "Push failed",
      }),
    ).rejects.toBe(err);
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Push failed — boom",
        duration: null,
      }),
    );
    // Sticky error toasts carry the "See details" escalation action.
    const toastCall = addToast.mock.calls[0]?.[0] as
      | { actions?: Array<{ label: string; onclick: () => void }> }
      | undefined;
    expect(toastCall?.actions).toHaveLength(1);
    expect(toastCall?.actions?.[0]?.label).toBe("See details");
    // Invoking the action opens the popover pre-selected on the ad-hoc
    // error entry the failure path just created.
    toastCall?.actions?.[0]?.onclick();
    expect(openTasksPopover).toHaveBeenCalledWith("adhoc-1");
  });

  it("skips success toast when omitted (silent-set)", async () => {
    await runMutation({
      kind: "stage",
      invoke: async () => undefined,
      failureToastPrefix: "Stage failed",
    });
    expect(addToast).not.toHaveBeenCalled();
  });

  it("tracks as a task when trackAsTask=true", async () => {
    await runMutation({
      kind: "fetch",
      invoke: async () => "ok",
      successToast: () => "Fetched",
      failureToastPrefix: "Fetch failed",
      trackAsTask: true,
    });
    expect(begin).toHaveBeenCalledWith("fetch");
    expect(complete).toHaveBeenCalledWith("task-1", { ok: true });
  });

  it("creates an ad-hoc task on failure when not tracked", async () => {
    const err = new Error("bad");
    await expect(
      runMutation({
        kind: "commit",
        invoke: async () => {
          throw err;
        },
        failureToastPrefix: "Commit failed",
      }),
    ).rejects.toBe(err);
    expect(createAdhoc).toHaveBeenCalledWith("commit", err);
  });

  it("routes the See details action to the tracked task id", async () => {
    const err = new Error("fetch blew up");
    await expect(
      runMutation({
        kind: "fetch",
        invoke: async () => {
          throw err;
        },
        failureToastPrefix: "Fetch failed",
        trackAsTask: true,
      }),
    ).rejects.toBe(err);
    const toastCall = addToast.mock.calls[0]?.[0] as
      | { actions?: Array<{ label: string; onclick: () => void }> }
      | undefined;
    toastCall?.actions?.[0]?.onclick();
    // Tracked failures route to the task id returned by `begin`, not a
    // fresh ad-hoc record — the Tasks popover has one canonical row.
    expect(openTasksPopover).toHaveBeenCalledWith("task-1");
    expect(createAdhoc).not.toHaveBeenCalled();
  });
});

/**
 * Slow-operation policy. `runMutation` is the only place UI mutations can
 * register themselves, so these pin down which kinds are tracked and which
 * project a registration lands on: the one captured at *call* time, not
 * whichever tab is focused when the invoke finally settles.
 */
describe("runMutation slow-op notice", () => {
  const REPO_A = "D:/repos/alpha";
  const REPO_B = "D:/repos/beta";

  /** A promise that settles after `ms` of fake time, driven by the test. */
  function timed(ms: number, err?: Error) {
    return new Promise<string>((resolve, reject) => {
      setTimeout(() => (err ? reject(err) : resolve("oid")), ms);
    });
  }

  /** Ops still attributed to a project — answers the *which repo* question. */
  const opsOf = (path: string) => get(getRepoState(path)!.busy.ops);

  beforeEach(() => {
    vi.useFakeTimers();
    __resetRepoStateForTests();
    __resetBusyForTests();
    createRepoState(REPO_A);
    createRepoState(REPO_B);
    setActiveRepoPath(REPO_A);
  });

  afterEach(() => {
    __resetBusyForTests();
    __resetRepoStateForTests();
    vi.useRealTimers();
  });

  it("raises the notice once a local git command passes the threshold", async () => {
    const pending = runMutation({
      kind: "commit",
      invoke: () => timed(5000),
      failureToastPrefix: "Commit failed",
    });

    await vi.advanceTimersByTimeAsync(SLOW_OP_MS - 1);
    expect(get(activeBusyNotice)).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(get(activeBusyNotice)).toBe(true);

    await vi.advanceTimersByTimeAsync(2_100);
    await pending;
    expect(get(activeBusyNotice)).toBe(false);
    expect(opsOf(REPO_A)).toEqual([]);
  });

  it("leaves a fast mutation untracked the whole way", async () => {
    const pending = runMutation({
      kind: "stage",
      invoke: () => timed(400),
      failureToastPrefix: "Stage failed",
    });
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    await vi.advanceTimersByTimeAsync(SLOW_OP_MS * 2);
    expect(get(activeBusyNotice)).toBe(false);
    expect(opsOf(REPO_A)).toEqual([]);
  });

  it("stays silent for a kind that is not a local git command", async () => {
    const pending = runMutation({
      kind: "push",
      invoke: () => timed(9000, new Error("no remote")),
      failureToastPrefix: "Push failed",
    }).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(SLOW_OP_MS * 2);
    expect(get(activeBusyNotice)).toBe(false);
    expect(opsOf(REPO_A)).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_100);
    await pending;
  });

  it("defers to the status-bar Tasks slot when the op is tracked as a task", async () => {
    // `rebase` IS a local git kind, so only the task rule keeps it out of the
    // dialog: the Tasks slot in the corner is already counting it, and one
    // operation should have exactly one progress surface.
    const pending = runMutation({
      kind: "rebase",
      invoke: () => timed(9000, new Error("conflict")),
      failureToastPrefix: "Rebase failed",
      trackAsTask: true,
    }).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(SLOW_OP_MS * 2);
    expect(get(activeBusyNotice)).toBe(false);
    expect(opsOf(REPO_A)).toEqual([]);
    // Sanity: it really did go through the task path being deferred to.
    expect(begin).toHaveBeenCalledWith("rebase");

    await vi.advanceTimersByTimeAsync(3_100);
    await pending;
  });

  it("honours busyNotice:false for a caller whose own UI reports progress", async () => {
    const pending = runMutation({
      kind: "commit",
      invoke: () => timed(9000),
      failureToastPrefix: "Commit failed",
      busyNotice: false,
    });

    await vi.advanceTimersByTimeAsync(SLOW_OP_MS * 2);
    expect(get(activeBusyNotice)).toBe(false);

    await vi.advanceTimersByTimeAsync(3_100);
    await pending;
  });

  it("attributes the op to the starting repo across a tab switch", async () => {
    const pending = runMutation({
      kind: "discard",
      invoke: () => timed(5000),
      failureToastPrefix: "Discard failed",
    });

    await vi.advanceTimersByTimeAsync(SLOW_OP_MS);
    // User leaves for an idle project: nothing may be shown over there…
    setActiveRepoPath(REPO_B);
    expect(get(activeBusyNotice)).toBe(false);
    expect(opsOf(REPO_B)).toEqual([]);
    // …while A still carries the running op.
    expect(opsOf(REPO_A)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_100);
    await pending;
    // The release landed on A, not on the tab focused when it finished.
    setActiveRepoPath(REPO_A);
    expect(get(activeBusyNotice)).toBe(false);
    expect(opsOf(REPO_A)).toEqual([]);
  });

  it("releases the op when the mutation fails", async () => {
    const err = new Error("io stuck");
    const pending = runMutation({
      kind: "clean",
      invoke: () => timed(SLOW_OP_MS + 500, err),
      failureToastPrefix: "Clean failed",
    });
    // The rejection handler is attached *before* the clock moves: a promise
    // that rejects with nothing listening is what vitest reports as an
    // unhandled rejection, and advancing the timer is what rejects it.
    const settled = expect(pending).rejects.toBe(err);
    await vi.advanceTimersByTimeAsync(SLOW_OP_MS + 600);
    await settled;
    expect(get(activeBusyNotice)).toBe(false);
    expect(opsOf(REPO_A)).toEqual([]);
  });

  it("is a no-op with no active project", async () => {
    setActiveRepoPath(null);
    const pending = runMutation({
      kind: "commit",
      invoke: () => timed(5000),
      failureToastPrefix: "Commit failed",
    });
    await vi.advanceTimersByTimeAsync(SLOW_OP_MS * 2);
    expect(get(activeBusyNotice)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(pending).resolves.toBe("oid");
  });
});
