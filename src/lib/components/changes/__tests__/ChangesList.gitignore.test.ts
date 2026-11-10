/**
 * ChangesList — right-click "Add to .gitignore" on a FOLDER row.
 *
 * File rows already have their own ignore patterns (buildGitignorePatterns);
 * this only covers the folder-shaped addition, which must write a pattern
 * for the directory itself (`/src/`) rather than for the changed files in
 * it. The last test is a regression guard: the file-row menu is unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/svelte";
import type { FileStatus } from "$lib/types";

vi.mock("$lib/api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api/tauri")>();
  return {
    ...actual,
    addGitignorePattern: vi.fn().mockResolvedValue(undefined),
    revealInFileManager: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("$lib/api/runMutation", () => ({
  runMutation: vi.fn(async (opts: { invoke: () => Promise<unknown> }) => opts.invoke()),
}));

import ChangesList from "../ChangesList.svelte";
import { addGitignorePattern } from "$lib/api/tauri";
import { changesTreeView } from "$lib/stores/changesView";
import { unstagedSelection, stagedSelection } from "$lib/stores/changesSelection";

const FILES: FileStatus[] = [{ path: "src/lib/a.ts", status: "new", is_staged: false }];

function renderList(isStaged = false) {
  return render(ChangesList, {
    props: {
      files: FILES,
      title: isStaged ? "Staged" : "Unstaged",
      isStaged,
    },
  });
}

/** Right-click a row by its data-testid and return the opened menu. */
async function openRowMenu(container: HTMLElement, testid: string): Promise<HTMLElement> {
  const row = container.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
  await fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
  return container.ownerDocument.querySelector(".context-menu") as HTMLElement;
}

/** Folder rows live only in tree mode. */
function dirTestid(dirPath: string): string {
  return `dir-row-${dirPath.replace(/\//g, "-")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  changesTreeView.set(true);
  unstagedSelection.set(new Set());
  stagedSelection.set(new Set());
});

afterEach(() => {
  cleanup();
  changesTreeView.set(false);
});

describe("ChangesList folder context menu — Add to .gitignore", () => {
  it("offers the action and writes a directory pattern for the folder", async () => {
    const { container } = renderList();
    const menu = await openRowMenu(container, dirTestid("src"));

    expect(within(menu).getByText("Add to .gitignore")).toBeTruthy();
    await fireEvent.click(within(menu).getByText("Add to .gitignore"));

    await vi.waitFor(() => expect(addGitignorePattern).toHaveBeenCalledWith("/src/"));
  });

  it("anchors a nested folder to the repo root", async () => {
    const { container } = renderList();
    const menu = await openRowMenu(container, dirTestid("src/lib"));

    await fireEvent.click(within(menu).getByText("Add to .gitignore"));

    await vi.waitFor(() => expect(addGitignorePattern).toHaveBeenCalledWith("/src/lib/"));
  });

  it("does not offer the action in the staged list", async () => {
    const { container } = renderList(true);
    const menu = await openRowMenu(container, dirTestid("src"));

    expect(within(menu).queryByText("Add to .gitignore")).toBeNull();
    expect(addGitignorePattern).not.toHaveBeenCalled();
  });

  it("keeps the existing per-file ignore patterns untouched", async () => {
    const { container } = renderList();
    const menu = await openRowMenu(container, "file-row-src-lib-a.ts");

    expect(within(menu).getByText('Ignore "a.ts"')).toBeTruthy();
    expect(within(menu).getByText("Ignore *.ts")).toBeTruthy();
    expect(within(menu).getByText("Ignore exact path")).toBeTruthy();
    expect(within(menu).getByText("Ignore src/")).toBeTruthy();
    // The folder-shaped single action is not duplicated onto file rows.
    expect(within(menu).queryByText("Add to .gitignore")).toBeNull();
  });
});
