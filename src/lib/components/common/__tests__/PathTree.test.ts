/**
 * PathTree: flat list below threshold, collapsible tree above.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import PathTree from "$lib/components/common/PathTree.svelte";

afterEach(() => cleanup());

const mkItems = (paths: string[]) => paths.map((p) => ({ path: p, meta: { additions: 1, deletions: 0 } }));

describe("PathTree", () => {
  it("renders a flat list below the threshold", () => {
    const { container } = render(PathTree, {
      items: mkItems(["a.ts", "b.ts"]),
      autoFlattenThreshold: 20,
      selectedPath: null,
    });
    expect(container.querySelectorAll("[data-pathtree-leaf]").length).toBe(2);
    expect(container.querySelector("[data-pathtree-folder]")).toBeNull();
  });

  it("renders a folder tree above the threshold", () => {
    const paths = Array.from({ length: 25 }, (_, i) => `src/dir${i % 3}/f${i}.ts`);
    const { container } = render(PathTree, {
      items: mkItems(paths),
      autoFlattenThreshold: 20,
      selectedPath: null,
    });
    expect(container.querySelectorAll("[data-pathtree-folder]").length).toBeGreaterThan(0);
  });

  it("fires onSelect with the full path when a leaf is clicked", async () => {
    const onSelect = vi.fn();
    const { getByRole } = render(PathTree, {
      items: mkItems(["a.ts"]),
      autoFlattenThreshold: 20,
      selectedPath: null,
      onSelect,
    });
    await fireEvent.click(getByRole("button", { name: /a\.ts/ }));
    expect(onSelect).toHaveBeenCalledWith("a.ts");
  });
});

/**
 * Rows are indented 16px per level, and the label used to be clamped to
 * whatever room was left — so a deep path rendered as an ellipsis and the
 * file stopped being identifiable. Rows now keep their natural width and
 * the tree scrolls sideways (see `styles/tree-scroll.css`).
 *
 * jsdom does no layout, so this guards the wiring rather than the widths:
 * drop the class and every row silently goes back to the panel width.
 */
describe("PathTree — sideways scroll for deep paths", () => {
  it("scrolls the flat list and lets its row grow to fit the path", () => {
    const { container } = render(PathTree, {
      items: mkItems(["src/lib/components/changes/ChangesList.svelte"]),
      autoFlattenThreshold: 20,
      selectedPath: null,
    });
    const list = container.querySelector("ul.path-flat");
    expect(list?.classList.contains("tree-x-scroll")).toBe(true);
    expect(list?.querySelector(".leaf")?.classList.contains("tree-x-row")).toBe(true);
  });

  it("uses the same pair for the tree, at every depth", async () => {
    const paths = Array.from(
      { length: 25 },
      (_, i) => `src/lib/components/deep/deeper/f${i}.ts`,
    );
    const { container } = render(PathTree, {
      items: mkItems(paths),
      autoFlattenThreshold: 20,
      selectedPath: null,
    });

    const roots = container.querySelectorAll("ul.path-tree");
    expect(roots).toHaveLength(1);
    expect(roots[0].classList.contains("tree-x-scroll")).toBe(true);

    // Folders start collapsed. Opening the deepest rendered folder each
    // time walks down one level without ever re-clicking (and collapsing)
    // a parent.
    for (let pass = 0; pass < 5; pass++) {
      const folders = container.querySelectorAll<HTMLElement>("[data-pathtree-folder]");
      await fireEvent.click(folders[folders.length - 1]);
      await tick();
    }

    const rows = [...container.querySelectorAll<HTMLElement>("[data-pathtree-folder], [data-pathtree-leaf]")];
    // Five levels of folder plus the 25 leaves, so the assertion below is
    // really about nested rows and not just the top one.
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.some((r) => /padding-left: (6[4-9]|[7-9]\d)px/.test(r.getAttribute("style") ?? ""))).toBe(true);
    for (const row of rows) {
      expect(row.classList.contains("tree-x-row")).toBe(true);
    }
  });
});
