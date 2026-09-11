/**
 * Tests for the shared FileChangeList component (used by CommitDetail /
 * TagDetail / CompareView). Verifies the opt-in tree mode (flat/tree toggle
 * renders only when `treeToggle` is set, tree mode groups files into
 * collapsible directory rows) and that the flat list keeps the
 * dimmed-directory + filename split with `onSelect` firing on clicks.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import FileChangeList from "../FileChangeList.svelte";

const FILES = [
  { path: "src/lib/a.ts", status: "added" },
  { path: "src/lib/deep/b.ts", status: "modified" },
  { path: "src/main.ts", status: "deleted" },
  { path: "README.md", status: "added" },
];

afterEach(() => cleanup());

describe("FileChangeList default (flat) mode", () => {
  it("renders every file flat with no toggle button", () => {
    const { container } = render(FileChangeList, { props: { files: FILES } });
    const items = container.querySelectorAll(".file-item");
    expect(items).toHaveLength(4);
    expect(container.querySelector('[data-testid="fcl-tree-toggle"]')).toBeNull();
    // Flat mode keeps the dimmed-directory + filename split.
    expect(container.querySelector(".file-dir")?.textContent).toBe("src/lib/");
  });

  it("fires onSelect when a file row is clicked", async () => {
    const onSelect = vi.fn();
    const { container } = render(FileChangeList, { props: { files: FILES, onSelect } });
    const row = container.querySelectorAll(".file-item")[2];
    await fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalledWith("src/main.ts");
  });
});

describe("FileChangeList tree mode", () => {
  it("renders the toggle only when treeToggle is set", () => {
    const { container } = render(FileChangeList, {
      props: { files: FILES, treeToggle: true },
    });
    expect(container.querySelector('[data-testid="fcl-tree-toggle"]')).toBeTruthy();
  });

  it("groups files into directory rows when switched to tree", async () => {
    const { container } = render(FileChangeList, {
      props: { files: FILES, treeToggle: true },
    });
    await fireEvent.click(
      container.querySelector('[data-testid="fcl-tree-toggle"]')!,
    );
    // Dirs: src, src/lib, src/lib/deep + files: src/main.ts, README.md
    const dirs = container.querySelectorAll(".dir-item");
    expect(dirs).toHaveLength(3);
    expect(dirs[0]?.textContent).toContain("src");
    expect(dirs[1]?.textContent).toContain("lib");
    expect(dirs[2]?.textContent).toContain("deep");
    // File leaves (all four files) use their bare name (depth-indented).
    expect(container.querySelectorAll(".file-item:not(.dir-item)")).toHaveLength(4);
  });

  it("collapses and expands a directory on its row click", async () => {
    const { container } = render(FileChangeList, {
      props: { files: FILES, treeToggle: true },
    });
    await fireEvent.click(
      container.querySelector('[data-testid="fcl-tree-toggle"]')!,
    );
    // Collapse "src" — its whole subtree disappears.
    await fireEvent.click(
      container.querySelector('[data-testid="fcl-dir-src"]')!,
    );
    const dirs = container.querySelectorAll(".dir-item");
    expect(dirs).toHaveLength(1);
    // Expand again.
    await fireEvent.click(
      container.querySelector('[data-testid="fcl-dir-src"]')!,
    );
    expect(container.querySelectorAll(".dir-item")).toHaveLength(3);
  });

  it("still fires onSelect for file rows in tree mode", async () => {
    const onSelect = vi.fn();
    const { container } = render(FileChangeList, {
      props: { files: FILES, onSelect, treeToggle: true },
    });
    await fireEvent.click(
      container.querySelector('[data-testid="fcl-tree-toggle"]')!,
    );
    const fileRows = container.querySelectorAll(".file-item:not(.dir-item)");
    await fireEvent.click(fileRows[0]!);
    // DFS, dirs-first: the deepest leaf under src comes first.
    expect(onSelect).toHaveBeenCalledWith("src/lib/deep/b.ts");
  });
});

/**
 * A commit's file list is indented 14px per tree level, and its rows used
 * to be stretched to the panel with the path clamped to an ellipsis — so a
 * deep path lost the filename, which is the only part worth reading.
 *
 * Rows now take their content's width and the list scrolls sideways
 * (`styles/tree-scroll.css`). jsdom does not lay out, so what is checked
 * here is the wiring: the class on the scroll container, the class on the
 * rows, and — for the windowed path, where the width is an inline style
 * because an absolutely positioned row has no class-level width to
 * inherit — that `right: auto` really reached the DOM.
 */
describe("FileChangeList — sideways scroll for deep paths", () => {
  it("makes the list the scroll container and its rows content-sized", () => {
    const { container } = render(FileChangeList, { props: { files: FILES } });
    const list = container.querySelector("ul.file-list")!;
    expect(list.classList.contains("tree-x-scroll")).toBe(true);
    for (const row of container.querySelectorAll("li")) {
      expect(row.classList.contains("tree-x-row")).toBe(true);
    }
  });

  it("gives every row the width even when the list is windowed", () => {
    // The window engages above 500 rows; jsdom reports no viewport, so the
    // component falls back to its assumed height and still windows.
    const many = Array.from({ length: 501 }, (_, i) => ({
      path: `src/lib/components/deep/deeper/f${i}.ts`,
      status: "modified",
    }));
    const { container } = render(FileChangeList, { props: { files: many } });

    const sizer = container.querySelector("li.virt-sizer");
    expect(sizer).not.toBeNull();
    const rows = [...sizer!.querySelectorAll<HTMLElement>("li.tree-x-row")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(many.length);

    const style = rows[0].getAttribute("style") ?? "";
    expect(style).toContain("position: absolute");
    expect(style).toContain("right: auto");
    expect(style).toContain("width: max-content");
    expect(style).toContain("min-width: 100%");
  });
});
