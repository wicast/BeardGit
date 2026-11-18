/**
 * A rename can also delete content lines (similarity < 100%). The Changes
 * list marks those rows with "^N" instead of "-N" so a rename isn't mistaken
 * for a deletion. The caret is gated strictly on the stat's own status — it
 * must never appear on modified/deleted/added rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import type { FileDiffStat, FileStatus } from "$lib/types";

import ChangesList from "../ChangesList.svelte";

function stat(path: string, status: string, deletions: number): FileDiffStat {
  return {
    path,
    old_path: null,
    status,
    additions: 0,
    deletions,
    binary: false,
  };
}

function file(path: string, status: string): FileStatus {
  return { path, status, is_staged: true };
}

const FILES: FileStatus[] = [
  file("scenes/lookdev.unity", "renamed"),
  file("scenes/other.unity", "modified"),
  file("scenes/gone.unity", "deleted"),
  file("scenes/fresh.unity", "new"),
];

const STATS = new Map<string, FileDiffStat>([
  ["scenes/lookdev.unity", stat("scenes/lookdev.unity", "renamed", 107)],
  ["scenes/other.unity", stat("scenes/other.unity", "modified", 42)],
  ["scenes/gone.unity", stat("scenes/gone.unity", "deleted", 9)],
  ["scenes/fresh.unity", stat("scenes/fresh.unity", "new", 3)],
]);

function rowText(container: HTMLElement, path: string): string {
  const row = container.querySelector(`[data-testid="file-row-${path.replace(/\//g, "-")}"]`);
  return row?.querySelector(".file-stat-del, .file-stat-renamed")?.textContent?.trim() ?? "";
}

afterEach(() => cleanup());

describe("ChangesList — rename deletion marker", () => {
  it("uses ^N only on renamed rows", () => {
    const { container } = render(ChangesList, {
      props: { files: FILES, title: "Staged", isStaged: true, stats: STATS },
    });

    expect(rowText(container, "scenes/lookdev.unity")).toBe("^107");
  });

  it("keeps -N on every non-renamed row with deletions", () => {
    const { container } = render(ChangesList, {
      props: { files: FILES, title: "Staged", isStaged: true, stats: STATS },
    });

    expect(rowText(container, "scenes/other.unity")).toBe("-42");
    expect(rowText(container, "scenes/gone.unity")).toBe("-9");
    expect(rowText(container, "scenes/fresh.unity")).toBe("-3");
  });

  it("never emits the caret class on a non-renamed row", () => {
    const { container } = render(ChangesList, {
      props: { files: FILES, title: "Staged", isStaged: true, stats: STATS },
    });

    const carets = container.querySelectorAll(".file-stat-renamed");
    expect(carets).toHaveLength(1);
    expect(carets[0].textContent?.trim()).toBe("^107");
  });
});
