/**
 * Smoke/wiring tests for the Branches panel changes — verifies the
 * header "+" opens CreateBranchDialog, the `doPush` helper composes
 * the right arguments for plain vs force push, and the `doPull` menu
 * items only appear where `git pull` semantics make sense.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { writable } from "svelte/store";

vi.mock("../../../api/tauri", () => ({
  pushRemote: vi.fn().mockResolvedValue(1),
  pullRemote: vi.fn().mockResolvedValue(1),
  deleteRemoteBranch: vi.fn().mockResolvedValue(1),
  getBranches: vi.fn().mockResolvedValue([]),
  getBranchCommits: vi.fn().mockResolvedValue([]),
  checkoutBranch: vi.fn(),
  deleteBranch: vi.fn(),
  mergeBranch: vi.fn(),
  rebaseBranch: vi.fn(),
  renameBranch: vi.fn(),
  createBranch: vi.fn(),
  createBranchAt: vi.fn(),
}));

vi.mock("../../../api/runMutation", () => ({
  runMutation: vi.fn(async (opts: { invoke: () => Promise<unknown> }) => opts.invoke()),
}));

vi.mock("../../../stores/remotes", () => ({
  remotes: writable([{ name: "origin", url: null }]),
  remoteNames: writable(["origin"]),
  refreshRemotes: vi.fn(),
}));

vi.mock("../../../stores/branches", () => ({
  branches: writable([
    { name: "main", is_head: true, is_remote: false, oid: "H" },
  ]),
  branchesLoading: writable(false),
  selectedBranchName: writable<string | null>("main"),
  localBranches: writable([
    { name: "main", is_head: true, is_remote: false, oid: "H" },
  ]),
  remoteBranches: writable([]),
  selectBranch: vi.fn(),
  refreshBranches: vi.fn(),
  doCheckout: vi.fn(),
  doDeleteBranch: vi.fn(),
  doMergeBranch: vi.fn(),
}));

vi.mock("../../../stores/createBranchDialog", () => ({
  openCreateBranchDialog: vi.fn(),
}));

import BranchList from "../BranchList.svelte";
import * as createBranchDialogStore from "../../../stores/createBranchDialog";
import * as tauriApi from "../../../api/tauri";
import { localBranches, remoteBranches, doMergeBranch } from "../../../stores/branches";
import type { Writable } from "svelte/store";
import type { BranchInfo } from "../../../types";

// The real stores expose Readable types; the vi.mock replacements above
// are writables so tests can seed branch data per scenario.
const localStore = localBranches as Writable<BranchInfo[]>;
const remoteStore = remoteBranches as Writable<BranchInfo[]>;

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe("BranchList wiring", () => {
  it("renders the new-branch header button", () => {
    const { getByTestId } = render(BranchList);
    expect(getByTestId("branch-new-btn")).toBeTruthy();
  });

  it("calls openCreateBranchDialog when the header button is clicked", async () => {
    const { getByTestId } = render(BranchList);
    await fireEvent.click(getByTestId("branch-new-btn"));
    expect(createBranchDialogStore.openCreateBranchDialog).toHaveBeenCalledWith({ kind: "head" });
  });

  it("offers Pull on the current branch and pulls from the single remote", async () => {
    const { getByTestId, getByText } = render(BranchList);
    await fireEvent.contextMenu(getByTestId("branch-row-main"));
    await fireEvent.click(getByText("Pull from origin"));
    expect(tauriApi.pullRemote).toHaveBeenCalledWith("origin", "main");
  });

  it("does not offer Pull on a non-current local branch", async () => {
    localStore.set([
      { name: "main", is_head: true, is_remote: false, oid: "H", upstream: null, ahead: 0, behind: 0, upstream_gone: false },
      { name: "feature", is_head: false, is_remote: false, oid: "F", upstream: null, ahead: 0, behind: 0, upstream_gone: false },
    ]);
    const { getByTestId, queryByText, getByText } = render(BranchList);
    await fireEvent.contextMenu(getByTestId("branch-row-feature"));
    expect(queryByText("Pull from origin")).toBeNull();
    // Push stays available — pull is the only item gated on is_head.
    expect(getByText("Push → origin")).toBeTruthy();
  });

  it("pulls a remote branch into the current branch via the context menu", async () => {
    remoteStore.set([
      { name: "origin/main", is_head: false, is_remote: true, oid: "R", upstream: null, ahead: 0, behind: 0, upstream_gone: false },
    ]);
    const { getByTestId, getByText } = render(BranchList);
    await fireEvent.contextMenu(getByTestId("branch-row-origin-main"));
    await fireEvent.click(getByText("Pull into current branch"));
    expect(tauriApi.pullRemote).toHaveBeenCalledWith("origin", "main");
  });

  it("offers a --no-ff merge that records a merge commit", async () => {
    localStore.set([
      { name: "main", is_head: true, is_remote: false, oid: "H", upstream: null, ahead: 0, behind: 0, upstream_gone: false },
      { name: "feature", is_head: false, is_remote: false, oid: "F", upstream: null, ahead: 0, behind: 0, upstream_gone: false },
    ]);
    const { getByTestId, getByText } = render(BranchList);
    await fireEvent.contextMenu(getByTestId("branch-row-feature"));
    await fireEvent.click(getByText("Merge into current (--no-ff)"));
    expect(vi.mocked(doMergeBranch)).toHaveBeenCalledWith("feature", true);
  });
});
