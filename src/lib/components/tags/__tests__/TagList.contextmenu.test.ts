/**
 * Wiring tests for the Tags panel's new push surfaces.
 *
 * Before this, both push entry points were hardcoded to `origin`. These
 * cover the two ways that changed:
 *
 *   - the row context menu, whose Push item fans out over every configured
 *     remote (direct when there is one, a submenu when there are several);
 *   - the row hover button and the "Push all tags" footer, which push to the
 *     single remote shared with the tag detail footer
 *     (`stores/tagPushRemote`) and are disabled when there is none.
 *
 * The menu's copy/delete entries are covered here too, since they share the
 * item list and a regression in the ordering would take the push item with
 * them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/svelte";
import { writable, get, type Writable } from "svelte/store";

vi.mock("../../../api/tauri", () => ({
  listTagsPaginated: vi.fn().mockResolvedValue([]),
  searchTags: vi.fn().mockResolvedValue([]),
  getCommitDetail: vi.fn().mockResolvedValue(null),
  getCommitStats: vi.fn().mockResolvedValue(null),
  getCommitFiles: vi.fn().mockResolvedValue([]),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  pushTag: vi.fn().mockResolvedValue(1),
  getRemotes: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../api/runMutation", () => ({
  runMutation: vi.fn(async (opts: { invoke: () => Promise<unknown> }) => opts.invoke()),
}));

vi.mock("../../../stores/graph", () => ({
  navigateToCommit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../stores/navigation", () => ({
  activeViewStore: writable("tags"),
}));

vi.mock("../../../stores/tags", () => ({
  tags: writable([]),
  tagsLoading: writable(false),
  hasMoreTags: writable(false),
  tagFilter: writable(""),
  // A derived store in the real module, a writable here so the test can
  // seed one tag. `vi.mock` factories are hoisted above the module body, so
  // the store has to be created inside the factory — the test writes to it
  // through a cast (see `seedTags`).
  filteredTags: writable([]),
  selectedTagName: writable<string | null>(null),
  selectTag: vi.fn(),
  loadMoreTags: vi.fn(),
  refreshTags: vi.fn(),
  searchTagsBackend: vi.fn(),
  restorePreFilterTags: vi.fn(),
  doDeleteTag: vi.fn(),
  doPushTag: vi.fn().mockResolvedValue(1),
}));

vi.mock("../../../stores/remotes", () => ({
  remotes: writable([]),
  remoteNames: writable([]),
  refreshRemotes: vi.fn(),
}));

import TagList from "../TagList.svelte";
import * as tagsStore from "../../../stores/tags";
import * as remotesStore from "../../../stores/remotes";
import * as graphStore from "../../../stores/graph";
import * as navigationStore from "../../../stores/navigation";
import { __resetViewMemory } from "../../../stores/viewMemory";

const TAG = {
  name: "v1.2.3",
  object_oid: "a".repeat(40),
  commit_oid: "b".repeat(40),
  annotated: true,
  message: "Release",
  tagger_name: "Adolfo",
  tagger_email: "a@example.com",
  date: "2026-06-10T10:00:00Z",
};

/** Seed the row list. `filteredTags` is derived in the real store module. */
function seedTags(items: (typeof TAG)[]): void {
  (tagsStore.filteredTags as unknown as Writable<(typeof TAG)[]>).set(items);
}

function setRemotes(...names: string[]): void {
  remotesStore.remotes.set(names.map((name) => ({ name, url: null })));
}

/** Right-click the only row and return the opened menu element. */
async function openRowMenu(container: HTMLElement): Promise<HTMLElement> {
  const row = container.querySelector(".list-row") as HTMLElement;
  await fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
  return container.ownerDocument.querySelector(".context-menu") as HTMLElement;
}

/**
 * Label of every top-level menu entry, in order, with separators as `null`.
 * Walks the menu's own children rather than its `.menu-item` descendants,
 * so a separator that stopped being rendered would fail the ordering
 * assertions instead of being skipped.
 */
function menuLabels(menu: HTMLElement): (string | null)[] {
  return [...menu.children].map((el) => {
    if (el.classList.contains("separator")) return null;
    return el.querySelector(".menu-item-label")?.textContent?.trim() ?? null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetViewMemory();
  seedTags([TAG]);
  setRemotes("origin", "upstream");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => cleanup());

describe("TagList row context menu", () => {
  it("opens on right-click with the tag's actions", async () => {
    const { container } = render(TagList);
    const menu = await openRowMenu(container);

    expect(menuLabels(menu)).toEqual([
      "Push",
      null, // separator
      "Copy tag name",
      `Copy commit SHA: ${TAG.commit_oid.slice(0, 8)}`,
      "Show commit in Graph",
      null, // separator
      "Delete",
    ]);
  });

  it("fans Push out over every remote as a submenu", async () => {
    const { container } = render(TagList);
    const menu = await openRowMenu(container);

    const parent = [...menu.querySelectorAll(".menu-item")].find((el) =>
      el.textContent?.includes("Push"),
    ) as HTMLElement;
    // Parents carry the chevron and do not fire on click.
    expect(parent.querySelector(".submenu-chevron")).not.toBeNull();
    expect(parent.classList.contains("has-children")).toBe(true);

    await fireEvent.mouseEnter(parent);
    const flyout = menu.querySelector(".submenu") as HTMLElement;
    expect(flyout).not.toBeNull();
    const options = [...flyout.querySelectorAll(".menu-item")].map((el) => el.textContent?.trim());
    expect(options).toEqual(["origin", "upstream"]);
  });

  it("pushes to the chosen remote", async () => {
    const { container } = render(TagList);
    const menu = await openRowMenu(container);
    const parent = [...menu.querySelectorAll(".menu-item")].find((el) =>
      el.textContent?.includes("Push"),
    ) as HTMLElement;
    await fireEvent.mouseEnter(parent);

    const upstream = [...menu.querySelectorAll(".submenu .menu-item")].find(
      (el) => el.textContent?.trim() === "upstream",
    ) as HTMLElement;
    await fireEvent.click(upstream);

    expect(tagsStore.doPushTag).toHaveBeenCalledWith(TAG.name, "upstream");
  });

  it("names the remote directly when there is only one", async () => {
    setRemotes("origin");
    const { container } = render(TagList);
    const menu = await openRowMenu(container);

    expect(menuLabels(menu)[0]).toBe("Push to origin");
    const only = menu.querySelector(".menu-item") as HTMLElement;
    expect(only.querySelector(".submenu-chevron")).toBeNull();

    await fireEvent.click(only);
    expect(tagsStore.doPushTag).toHaveBeenCalledWith(TAG.name, "origin");
  });

  it("hides Push entirely when the repository has no remotes", async () => {
    setRemotes();
    const { container } = render(TagList);
    const menu = await openRowMenu(container);

    expect(menuLabels(menu)).toEqual([
      "Copy tag name",
      `Copy commit SHA: ${TAG.commit_oid.slice(0, 8)}`,
      "Show commit in Graph",
      null,
      "Delete",
    ]);
  });

  it("copies the tag name", async () => {
    const { container } = render(TagList);
    const menu = await openRowMenu(container);
    await fireEvent.click(within(menu).getByText("Copy tag name"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(TAG.name);
  });

  it("copies the full commit SHA, not the abbreviation shown in the label", async () => {
    const { container } = render(TagList);
    const menu = await openRowMenu(container);
    await fireEvent.click(within(menu).getByText(`Copy commit SHA: ${TAG.commit_oid.slice(0, 8)}`));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(TAG.commit_oid);
  });

  it("jumps to the commit in the Graph view", async () => {
    const { container } = render(TagList);
    const menu = await openRowMenu(container);
    await fireEvent.click(within(menu).getByText("Show commit in Graph"));

    expect(graphStore.navigateToCommit).toHaveBeenCalledWith(TAG.commit_oid);
    // Without the view switch the commit is selected behind a Tags view
    // that never visibly moves.
    expect(get(navigationStore.activeViewStore)).toBe("graph");
  });

  it("routes Delete through the existing confirmation dialog", async () => {
    const { container } = render(TagList);
    const menu = await openRowMenu(container);
    // Scoped to the menu: the row's hover actions carry a Delete button too.
    await fireEvent.click(within(menu).getByText("Delete"));

    // The dialog, not the mutation: deletion is destructive and stays
    // behind a confirm.
    expect(tagsStore.doDeleteTag).not.toHaveBeenCalled();
    expect(container.ownerDocument.body.textContent).toContain("Delete tag");
  });
});

describe("TagList push controls", () => {
  it("pushes all tags to the shared default remote", async () => {
    const { getByText } = render(TagList);
    await fireEvent.click(getByText("Push All Tags"));
    expect(tagsStore.doPushTag).toHaveBeenCalledWith(null, "origin");
  });

  it("follows the shared remote selection", async () => {
    const { getByTestId, getByText } = render(TagList);
    const picker = getByTestId("tag-push-all-remote") as HTMLSelectElement;
    expect(picker.value).toBe("origin");

    await fireEvent.change(picker, { target: { value: "upstream" } });
    expect(picker.value).toBe("upstream");

    await fireEvent.click(getByText("Push All Tags"));
    expect(tagsStore.doPushTag).toHaveBeenCalledWith(null, "upstream");
  });

  it("renders no picker and disables push when there are no remotes", () => {
    setRemotes();
    const { queryByTestId, getByText } = render(TagList);

    expect(queryByTestId("tag-push-all-remote")).toBeNull();
    const pushAll = getByText("Push All Tags").closest("button") as HTMLButtonElement;
    expect(pushAll.disabled).toBe(true);
  });
});
