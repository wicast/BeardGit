/**
 * WorkdirTree — the editor's file tree, and the sideways scroll that keeps
 * a deep path readable.
 *
 * `FileTreeView`'s `.tree-body` has always been `overflow: auto`, so the
 * container was never the problem: every row was `width: 100%` with the
 * name clamped to an ellipsis, and past a certain depth the row had no
 * room left for anything but the ellipsis. The tree could scroll, and
 * there was nothing to scroll to.
 *
 * Rows now take their content's width (`.tree-x-row`) inside that scroller
 * (`.tree-x-scroll`) — see `styles/tree-scroll.css`. jsdom does not lay
 * out, so what is asserted here is the wiring on every level of the
 * recursion, which is the part a future edit can drop silently.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkdirTreeEntry } from "$lib/types";

import WorkdirTree from "../WorkdirTree.svelte";
import { expandedDirs, treeChildren } from "$lib/stores/fileEditor";

function dir(path: string): WorkdirTreeEntry {
  return { path, name: path.split("/").pop()!, is_directory: true, size: null };
}

function file(path: string): WorkdirTreeEntry {
  return { path, name: path.split("/").pop()!, is_directory: false, size: 12 };
}

afterEach(() => {
  cleanup();
  treeChildren.set(new Map());
  expandedDirs.set(new Set());
});

/** Two levels, so the recursion renders rows from more than one `<WorkdirTree>`. */
function seedTree(): void {
  treeChildren.set(
    new Map([
      ["", [dir("src"), file("README.md")]],
      [
        "src",
        [dir("src/components"), file("src/main.ts")],
      ],
      [
        "src/components",
        [file("src/components/a-very-long-component-name.svelte")],
      ],
    ]),
  );
  expandedDirs.set(new Set(["src", "src/components"]));
}

describe("WorkdirTree — sideways scroll for deep paths", () => {
  it("gives every row, at every level, its own content width", () => {
    seedTree();
    const { container } = render(WorkdirTree, {
      props: { selectedPath: null, respectGitignore: false, onSelect: () => {} },
    });

    const rows = [...container.querySelectorAll<HTMLElement>(".row")];
    // Root entries plus both expanded levels.
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.classList.contains("tree-x-row")).toBe(true);
    }

    // The deepest row is the one that used to render as an ellipsis: it is
    // indented by its level and carries the full name. It is not simply the
    // last row — a folder's children render directly under it.
    const deepest = rows.find((r) =>
      r.textContent?.includes("a-very-long-component-name.svelte"),
    );
    expect(deepest).toBeDefined();
    expect(deepest!.getAttribute("style")).toContain("padding-left: 34px");
  });

  it("keeps the row's own width out of the component's stylesheet", () => {
    // `width: 100%` here is the bug the class replaced, and a scoped rule
    // would outrank `.tree-x-row` — a leftover declaration would pin every
    // row back to the panel with no visible failure anywhere else.
    const source = readFileSync(
      join(process.cwd(), "src/lib/components/file-editor/WorkdirTree.svelte"),
      "utf8",
    );
    const row = /\.row\s*\{[^}]*\}/.exec(source)?.[0] ?? "";
    expect(row).not.toBe("");
    expect(row).not.toMatch(/(^|[;\s])width\s*:/);
  });
});
