/**
 * FileTreeView row context menu — the "File History" entry.
 *
 * The staging list and commit detail already offer right-click → File
 * History; the editor's workdir tree was the one file surface missing it.
 * These cover the two shapes the menu takes: a file row gets the entry and
 * hands its repo-relative path to the panel, a directory row does not (git
 * has no history for a directory).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/svelte";
import { writable, type Writable } from "svelte/store";
import type { WorkdirTreeEntry } from "$lib/types";

vi.mock("$lib/stores/fileEditor", () => ({
  DIRECTORY_ENTRY_CAP: 10000,
  activeTabPath: writable<string | null>(null),
  knownEntries: writable(new Map<string, WorkdirTreeEntry>()),
  openTab: vi.fn().mockResolvedValue(undefined),
  refreshTree: vi.fn().mockResolvedValue(undefined),
  revealInTree: vi.fn().mockResolvedValue(undefined),
  searchLoading: writable(false),
  searchResults: writable<WorkdirTreeEntry[]>([]),
  searchTree: vi.fn().mockResolvedValue(undefined),
  searchTruncated: writable(false),
  treeChildren: writable(new Map<string, WorkdirTreeEntry[]>()),
  treeLoading: writable(false),
  expandedDirs: writable(new Set<string>()),
  failedDirs: writable(new Set<string>()),
  loadingDirs: writable(new Set<string>()),
  toggleDirectory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/api/tauri", () => ({
  revealInFileManager: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/stores/projects", () => ({
  activeProject: writable({ path: "/repo" }),
}));

vi.mock("$lib/stores/editorPrefs", () => ({
  editorPrefs: writable({ reveal_active_file_in_tree: false }),
}));

import FileTreeView from "../FileTreeView.svelte";
import { knownEntries, treeChildren } from "$lib/stores/fileEditor";

const DIR: WorkdirTreeEntry = {
  path: "src",
  name: "src",
  is_directory: true,
  size: null,
};
const FILE: WorkdirTreeEntry = {
  path: "src/main.ts",
  name: "main.ts",
  is_directory: false,
  size: 12,
};

function props() {
  return {
    respectGitignore: false,
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onFileHistory: vi.fn(),
  };
}

/** Right-click one row and return the opened menu element. */
async function openRowMenu(container: HTMLElement, path: string): Promise<HTMLElement> {
  const row = container.querySelector(`[aria-label="${path}"]`) as HTMLElement;
  await fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
  return container.ownerDocument.querySelector(".context-menu") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `treeChildren` renders the rows, `knownEntries` is where the menu looks
  // them up. Both are `Readable` derived stores in the real module; the mock
  // backs them with writables so a test can seed rows.
  (treeChildren as unknown as Writable<Map<string, WorkdirTreeEntry[]>>).set(
    new Map([["", [DIR, FILE]]]),
  );
  (knownEntries as unknown as Writable<Map<string, WorkdirTreeEntry>>).set(
    new Map([
      [DIR.path, DIR],
      [FILE.path, FILE],
    ]),
  );
});

afterEach(cleanup);

describe("FileTreeView row context menu — File History", () => {
  it("offers File History on a file row", async () => {
    const { container } = render(FileTreeView, { props: props() });
    const menu = await openRowMenu(container, FILE.path);

    expect(within(menu).getByText("File History")).toBeTruthy();
  });

  it("hands the repo-relative path to the panel when clicked", async () => {
    const p = props();
    const { container } = render(FileTreeView, { props: p });
    const menu = await openRowMenu(container, FILE.path);

    await fireEvent.click(within(menu).getByText("File History"));

    expect(p.onFileHistory).toHaveBeenCalledWith(FILE.path);
    expect(p.onFileHistory).toHaveBeenCalledTimes(1);
  });

  it("does not offer File History on a directory row", async () => {
    const { container } = render(FileTreeView, { props: props() });
    const menu = await openRowMenu(container, DIR.path);

    expect(within(menu).queryByText("File History")).toBeNull();
    // The directory's own actions are still there — the row is not silently
    // losing its whole menu.
    expect(within(menu).getByText("New file here")).toBeTruthy();
  });
});
