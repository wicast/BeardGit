import { describe, expect, it } from "vitest";
import {
  buildChangesTree,
  flattenTree,
  changedFilesUnderDir,
} from "../changes-tree";
import type { FileStatus } from "$lib/types";

function fs(path: string, status = "modified"): FileStatus {
  return { path, status, is_staged: false } as FileStatus;
}

describe("buildChangesTree", () => {
  it("keeps root-level files as file nodes", () => {
    const tree = buildChangesTree([fs("README.md"), fs("main.rs")]);
    // Case-insensitive sort: "main.rs" < "readme.md".
    expect(tree.map((n) => n.path)).toEqual(["main.rs", "README.md"]);
    expect(tree.every((n) => n.kind === "file")).toBe(true);
  });

  it("groups files into nested directories", () => {
    const tree = buildChangesTree([
      fs("src/lib/a.ts"),
      fs("src/lib/deep/b.ts"),
      fs("src/main.ts"),
      fs("docs/x.md"),
    ]);
    expect(tree).toHaveLength(2);
    const [docs, src] = tree;
    expect(docs?.kind).toBe("dir");
    expect(src?.kind).toBe("dir");
    if (src?.kind === "dir") {
      expect(src.path).toBe("src");
      // Dirs sort before files: the lib dir precedes main.ts.
      expect(src.children.map((c) => c.path)).toEqual(["src/lib", "src/main.ts"]);
      const lib = src.children[0];
      if (lib?.kind === "dir") {
        // Dirs first again: deep/ before a.ts.
        expect(lib.children.map((c) => c.name)).toEqual(["deep", "a.ts"]);
        const deep = lib.children[0];
        if (deep?.kind === "dir") expect(deep.path).toBe("src/lib/deep");
        else expect.unreachable("first lib child must be the deep dir");
      } else {
        expect.unreachable("first src child must be the lib dir");
      }
    }
    void docs;
  });

  it("sorts directories before files, case-insensitively", () => {
    const tree = buildChangesTree([
      fs("beta.txt"),
      fs("Alpha/inner.txt"),
      fs("alpha-file.txt"),
    ]);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
      "dir:Alpha",
      "file:alpha-file.txt",
      "file:beta.txt",
    ]);
  });

  it("carries the FileStatus payload on leaves", () => {
    const tree = buildChangesTree([fs("src/a.ts", "new")]);
    const src = tree[0];
    if (src?.kind === "dir") {
      const leaf = src.children[0];
      if (leaf?.kind === "file") expect(leaf.file.status).toBe("new");
      else expect.unreachable();
    } else {
      expect.unreachable();
    }
  });
});

describe("flattenTree", () => {
  const tree = buildChangesTree([
    fs("src/lib/a.ts"),
    fs("src/main.ts"),
    fs("README.md"),
  ]);

  it("lists every node expanded, depth-first", () => {
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => r.node.path)).toEqual([
      "src",
      "src/lib",
      "src/lib/a.ts",
      "src/main.ts",
      "README.md",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0]);
  });

  it("omits children of collapsed directories", () => {
    const rows = flattenTree(tree, new Set(["src/lib"]));
    expect(rows.map((r) => r.node.path)).toEqual([
      "src",
      "src/lib",
      "src/main.ts",
      "README.md",
    ]);
  });

  it("collapsing a root keeps its own row and hides the subtree", () => {
    const rows = flattenTree(tree, new Set(["src"]));
    expect(rows.map((r) => r.node.path)).toEqual(["src", "README.md"]);
  });
});

describe("changedFilesUnderDir", () => {
  const tree = buildChangesTree([
    fs("src/lib/a.ts"),
    fs("src/lib/deep/b.ts"),
    fs("src/main.ts"),
    fs("README.md"),
  ]);

  it("expands all changed files beneath the directory (dirs-first order)", () => {
    expect(changedFilesUnderDir(tree, "src")).toEqual([
      "src/lib/deep/b.ts",
      "src/lib/a.ts",
      "src/main.ts",
    ]);
  });

  it("works for nested directories", () => {
    expect(changedFilesUnderDir(tree, "src/lib")).toEqual([
      "src/lib/deep/b.ts",
      "src/lib/a.ts",
    ]);
  });

  it("returns nothing for unknown directories", () => {
    expect(changedFilesUnderDir(tree, "nope")).toEqual([]);
  });
});
