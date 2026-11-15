/**
 * StagingArea — right-clicking blank space in the changes lists.
 *
 * The empty area of the shared `.file-lists` scroller used to have no menu at
 * all. It now offers the same git actions as checking every row in both lists:
 * stage/unstage/discard their own side, stash and copy paths over all changes.
 * Row right-clicks keep their own (per-file or folder) menus.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/svelte";
import type { FileStatus } from "$lib/types";
import { mockInvokeResponse, invokeMock } from "../../../../test/setup";

import StagingArea from "../StagingArea.svelte";
import { unstagedSelection, stagedSelection } from "$lib/stores/changesSelection";
import { changesTreeView } from "$lib/stores/changesView";

// `src/app.ts` deliberately appears on both sides: a staged file that was
// edited again. Stash / Copy Paths must count it once, stage/discard use only
// the unstaged side and unstage only the staged side.
const FILES: FileStatus[] = [
  { path: "src/app.ts", status: "modified", is_staged: true },
  { path: "src/app.ts", status: "modified", is_staged: false },
  { path: "README.md", status: "modified", is_staged: false },
  { path: "new.txt", status: "new", is_staged: false },
];

function seedStatuses(files: FileStatus[] = FILES) {
  mockInvokeResponse("get_file_statuses", files);
  mockInvokeResponse("get_diff_stats_workdir", []);
  mockInvokeResponse("get_diff_stats_index", []);
}

async function renderStaging(files?: FileStatus[]) {
  seedStatuses(files);
  const result = render(StagingArea);
  // Let onMount's refreshes settle so `staged` / `unstaged` are populated.
  await new Promise((r) => setTimeout(r, 0));
  return result;
}

/** Right-click the blank scroller itself (not a row) and return the menu. */
async function openBlankMenu(container: HTMLElement): Promise<HTMLElement | null> {
  const blank = container.querySelector('[data-testid="changes-file-lists"]') as HTMLElement;
  await fireEvent.contextMenu(blank, { clientX: 50, clientY: 500 });
  return container.ownerDocument.querySelector<HTMLElement>(".context-menu");
}

beforeEach(() => {
  vi.clearAllMocks();
  changesTreeView.set(false);
  unstagedSelection.set(new Set());
  stagedSelection.set(new Set());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => cleanup());

describe("StagingArea blank-area context menu", () => {
  it("offers all-change actions with per-action counts and de-duplicated paths", async () => {
    const { container } = await renderStaging();
    const menu = await openBlankMenu(container);

    expect(menu).toBeTruthy();
    expect(within(menu!).getByText("Stage All (3)")).toBeTruthy();
    expect(within(menu!).getByText("Unstage All (1)")).toBeTruthy();
    expect(within(menu!).getByText("Discard All (3)")).toBeTruthy();
    expect(within(menu!).getByText("Stash All (3)")).toBeTruthy();
    expect(within(menu!).getByText("Copy All Paths (3)")).toBeTruthy();
  });

  it("stages every unstaged path", async () => {
    const { container } = await renderStaging();
    const menu = await openBlankMenu(container);

    await fireEvent.click(within(menu!).getByText("Stage All (3)"));

    expect(invokeMock).toHaveBeenCalledWith("stage_files", {
      paths: ["src/app.ts", "README.md", "new.txt"],
    });
  });

  it("unstages every staged path", async () => {
    const { container } = await renderStaging();
    const menu = await openBlankMenu(container);

    await fireEvent.click(within(menu!).getByText("Unstage All (1)"));

    expect(invokeMock).toHaveBeenCalledWith("unstage_files", {
      paths: ["src/app.ts"],
    });
  });

  it("discards every unstaged path behind a confirmation", async () => {
    const { container } = await renderStaging();
    const menu = await openBlankMenu(container);

    await fireEvent.click(within(menu!).getByText("Discard All (3)"));
    const confirm = container.ownerDocument.querySelector('[data-testid="dialog-confirm-btn"]') as HTMLElement;
    expect(confirm).toBeTruthy();
    await fireEvent.click(confirm);

    expect(invokeMock).toHaveBeenCalledWith("discard_files", {
      paths: ["src/app.ts", "README.md", "new.txt"],
    });
  });

  it("stashes and copies all unique paths", async () => {
    const { container } = await renderStaging();
    const menu = await openBlankMenu(container);

    await fireEvent.click(within(menu!).getByText("Stash All (3)"));
    expect(invokeMock).toHaveBeenCalledWith("stash_push", {
      message: null,
      paths: ["src/app.ts", "README.md", "new.txt"],
    });

    const menuAgain = await openBlankMenu(container);
    await fireEvent.click(within(menuAgain!).getByText("Copy All Paths (3)"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "src/app.ts\nREADME.md\nnew.txt",
    );
  });

  it("keeps the row menu on a right-clicked file row", async () => {
    const { container } = await renderStaging();
    const row = container.querySelector('[data-testid="file-row-README.md"]') as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 40, clientY: 80 });

    const menus = container.ownerDocument.querySelectorAll(".context-menu");
    expect(menus).toHaveLength(1);
    expect(within(menus[0] as HTMLElement).getByText("Stage")).toBeTruthy();
    expect(within(menus[0] as HTMLElement).queryByText("Stage All (3)")).toBeNull();
  });

  it("opens nothing when the working tree has no changes", async () => {
    const { container } = await renderStaging([]);
    const menu = await openBlankMenu(container);

    expect(menu).toBeNull();
  });
});
