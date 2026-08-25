/**
 * Tests for the opt-in tree mode of the shared FileChangeList component
 * (used by CommitDetail / TagDetail / CompareView). Verifies that the
 * flat/tree toggle renders only when `treeToggle` is set, that tree mode
 * groups files into collapsible directory rows, and that file-row clicks
 * still fire `onSelect`.
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