/**
 * ChangesList — the sideways scroll that keeps a deep tree path readable.
 *
 * Rows are indented 14px per level and used to be stretched to the panel
 * with the path clamped to an ellipsis, so past a certain depth the row
 * read `…` and the file could not be identified at all. Rows now take
 * their content's width and the list scrolls sideways — see
 * `styles/tree-scroll.css` for the contract between the two classes.
 *
 * jsdom does not lay out, so these assert the wiring: without the class on
 * the container nothing can scroll, and without it on the rows (or with
 * the old `width: 100%` back in the stylesheet) nothing ever grows past
 * the panel. The windowed path is checked too, because its width is an
 * inline style rather than a class.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileStatus } from "$lib/types";

import ChangesList from "../ChangesList.svelte";
import { changesTreeView } from "$lib/stores/changesView";

const FILES: FileStatus[] = [
  { path: "src/lib/components/changes/ChangesList.svelte", status: "modified", is_staged: false },
  { path: "src/main.ts", status: "modified", is_staged: false },
];

afterEach(() => {
  cleanup();
  changesTreeView.set(false);
});

describe("ChangesList — sideways scroll for deep paths", () => {
  it("scrolls the list and lets a row grow to fit its path", () => {
    const { container } = render(ChangesList, {
      props: { files: FILES, title: "Unstaged" },
    });

    const list = container.querySelector(".file-list");
    expect(list?.classList.contains("tree-x-scroll")).toBe(true);

    const rows = container.querySelectorAll(".file-item");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.classList.contains("tree-x-row")).toBe(true);
    }
  });

  it("covers nested tree rows too", () => {
    changesTreeView.set(true);
    const { container } = render(ChangesList, {
      props: { files: FILES, title: "Unstaged" },
    });

    // Directories and their leaves: both kinds are rows of the same list.
    expect(container.querySelectorAll(".dir-item").length).toBeGreaterThan(0);
    for (const row of container.querySelectorAll(".file-item")) {
      expect(row.classList.contains("tree-x-row")).toBe(true);
    }
  });

  it("gives the width to a windowed row as well, which has no class to inherit it", () => {
    // Windowed above 500 rows; jsdom reports no viewport, so the component
    // falls back to its assumed height and still windows.
    const many: FileStatus[] = Array.from({ length: 501 }, (_, i) => ({
      path: `src/lib/components/deep/deeper/f${i}.ts`,
      status: "modified",
      is_staged: false,
    }));
    const { container } = render(ChangesList, {
      props: { files: many, title: "Unstaged" },
    });

    const sizer = container.querySelector(".virt-sizer");
    expect(sizer).not.toBeNull();
    const rows = [...sizer!.querySelectorAll<HTMLElement>(".file-item")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(many.length);

    const style = rows[0].getAttribute("style") ?? "";
    expect(style).toContain("position: absolute");
    expect(style).toContain("right: auto");
    expect(style).toContain("width: max-content");
    expect(style).toContain("min-width: 100%");
  });

  it("keeps a width declaration out of the row's own stylesheet", () => {
    // A Svelte-scoped rule outranks the single-class utility, so a
    // reintroduced `width: 100%` would silently pin every row back to the
    // panel width and the feature would stop working with no error.
    const source = readFileSync(
      join(process.cwd(), "src/lib/components/changes/ChangesList.svelte"),
      "utf8",
    );
    const row = /\.file-item\s*\{[^}]*\}/.exec(source)?.[0] ?? "";
    expect(row).not.toBe("");
    expect(row).not.toMatch(/(^|[;\s])width\s*:/);
  });
});
