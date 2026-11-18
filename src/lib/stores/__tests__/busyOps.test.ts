/**
 * Unit tests for the slow-operation tracker (`busyOps`).
 *
 * The timer bookkeeping is the part worth pinning down: the notice must
 * appear for an op that is *still* running at the threshold, must not appear
 * for one that finished earlier, must be shared by a batch rather than
 * stacked per op, and must be recorded against the project that started the
 * work — never whichever tab happens to be focused when it lands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import {
  SLOW_OP_MS,
  beginBusy,
  endBusy,
  withBusyNotice,
  hideBusyNotice,
  isSlowOpKind,
  activeBusyOps,
  activeBusyNotice,
  busyDialogVisible,
  __resetBusyForTests,
} from "$lib/stores/busyOps";
import {
  createRepoState,
  dropRepoState,
  getRepoState,
  setActiveRepoPath,
  __resetRepoStateForTests,
} from "$lib/stores/repo-state";

const A = "D:/repos/alpha";
const B = "D:/repos/beta";

const noticeOf = (path: string): boolean => get(getRepoState(path)!.busy.notice) ?? false;

beforeEach(() => {
  vi.useFakeTimers();
  __resetRepoStateForTests();
  __resetBusyForTests();
  createRepoState(A);
  createRepoState(B);
  setActiveRepoPath(A);
});

afterEach(() => {
  __resetBusyForTests();
  __resetRepoStateForTests();
  vi.useRealTimers();
});

describe("beginBusy / endBusy", () => {
  it("raises the notice exactly at the threshold", () => {
    const id = beginBusy(A, "commit");
    vi.advanceTimersByTime(SLOW_OP_MS - 1);
    expect(noticeOf(A)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(noticeOf(A)).toBe(true);
    endBusy(A, id);
  });

  it("cancels the timer when the op finishes first", () => {
    const id = beginBusy(A, "stage");
    vi.advanceTimersByTime(SLOW_OP_MS - 500);
    endBusy(A, id);
    vi.advanceTimersByTime(SLOW_OP_MS);
    expect(noticeOf(A)).toBe(false);
    expect(get(activeBusyOps)).toEqual([]);
  });

  it("shares one notice across a batch and clears it only when all drain", () => {
    const first = beginBusy(A, "discard");
    const second = beginBusy(A, "commit");
    vi.advanceTimersByTime(SLOW_OP_MS);
    expect(noticeOf(A)).toBe(true);
    expect(get(activeBusyOps)).toHaveLength(2);

    endBusy(A, first);
    expect(noticeOf(A)).toBe(true);
    endBusy(A, second);
    expect(noticeOf(A)).toBe(false);
  });

  it("re-asks for a later batch after the previous one drained", () => {
    const id = beginBusy(A, "commit");
    vi.advanceTimersByTime(SLOW_OP_MS);
    endBusy(A, id);
    const next = beginBusy(A, "commit");
    expect(noticeOf(A)).toBe(false);
    vi.advanceTimersByTime(SLOW_OP_MS);
    expect(noticeOf(A)).toBe(true);
    endBusy(A, next);
  });

  it("ignores an unresolvable project without throwing", () => {
    expect(beginBusy(null, "commit")).toBeNull();
    expect(beginBusy("", "commit")).toBeNull();
    expect(beginBusy("D:/repos/not-open", "commit")).toBeNull();
    // …and the matching endBusy is a no-op too.
    endBusy("D:/repos/not-open", 12345);
  });

  it("tolerates a project closing while its op is still in flight", () => {
    const id = beginBusy(A, "checkout");
    dropRepoState(A);
    vi.advanceTimersByTime(SLOW_OP_MS);
    expect(() => endBusy(A, id)).not.toThrow();
    expect(get(activeBusyNotice)).toBe(false);
  });
});

describe("project isolation", () => {
  it("marks only the project that started the operation", async () => {
    const idInB = beginBusy(B, "clean");
    vi.advanceTimersByTime(SLOW_OP_MS);

    expect(noticeOf(B)).toBe(true);
    expect(noticeOf(A)).toBe(false);
    // A is the focused repo, so nothing shows even though B is grinding.
    expect(get(activeBusyNotice)).toBe(false);
    expect(get(busyDialogVisible)).toBe(false);

    setActiveRepoPath(B);
    expect(get(busyDialogVisible)).toBe(true);

    endBusy(B, idInB);
    setActiveRepoPath(A);
    await Promise.resolve();
  });

  it("runs withBusyNotice for the given project and always releases it", async () => {
    await withBusyNotice(A, "commit", async () => {
      vi.advanceTimersByTime(SLOW_OP_MS);
      expect(noticeOf(A)).toBe(true);
      expect(noticeOf(B)).toBe(false);
    });
    expect(noticeOf(A)).toBe(false);
    expect(get(activeBusyOps)).toEqual([]);
  });

  it("releases even when the operation rejects", async () => {
    await expect(
      withBusyNotice(A, "commit", async () => {
        vi.advanceTimersByTime(SLOW_OP_MS);
        throw new Error("discard failed");
      }),
    ).rejects.toThrow("discard failed");
    expect(noticeOf(A)).toBe(false);
  });
});

describe("hideBusyNotice", () => {
  it("suppresses the visible flag without forgetting the running op", () => {
    const id = beginBusy(A, "commit");
    vi.advanceTimersByTime(SLOW_OP_MS);
    expect(get(busyDialogVisible)).toBe(true);

    hideBusyNotice();
    expect(get(busyDialogVisible)).toBe(false);
    expect(noticeOf(A)).toBe(true);
    expect(get(activeBusyOps)).toHaveLength(1);

    endBusy(A, id);
    expect(get(activeBusyNotice)).toBe(false);
    // Un-muted with the batch, so the next slow op is visible again.
    const next = beginBusy(A, "commit");
    vi.advanceTimersByTime(SLOW_OP_MS);
    expect(get(busyDialogVisible)).toBe(true);
    endBusy(A, next);
  });
});

describe("isSlowOpKind", () => {
  it("covers the local, IO-bound git commands", () => {
    for (const kind of ["commit", "discard", "stage", "checkout", "clean", "reset_hard", "stash_pop"]) {
      expect(isSlowOpKind(kind)).toBe(true);
    }
  });

  it("lists rebase here even though its call sites track it as a task", () => {
    // A rebase really is working-tree IO, so it qualifies by kind; the two
    // callers that issue it pass `trackAsTask`, and the task rule — not this
    // set — is what leaves the status-bar slot as its only indicator.
    expect(isSlowOpKind("rebase")).toBe(true);
  });

  it("excludes network-backed and non-git kinds", () => {
    for (const kind of ["fetch", "pull", "push", "push_force", "tag_push", "remote_branch_delete"]) {
      expect(isSlowOpKind(kind)).toBe(false);
    }
    for (const kind of ["mr_pr_comment", "release_create", "requests_save", "ai_cancel_run"]) {
      expect(isSlowOpKind(kind)).toBe(false);
    }
  });
});
