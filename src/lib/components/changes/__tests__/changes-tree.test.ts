import { describe, expect, it } from "vitest";
import {
  buildChangesTree,
  buildGenericChangesTree,
  flattenTree,
  changedFilesUnderDir,
  dirSelectionCounts,
  dirCheckState,
  toggleDirSelection,
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
      if (leaf?.kind === "file") expect(leaf.payload.status).toBe("new");
      else expect.unreachable();
    } else {
      expect.unreachable();
    }
  });
});

describe("buildGenericChangesTree", () => {
  const cc = (path: string, status = "added") => ({ path, status });

  it("groups CommitFileChange-shaped entries like the FileStatus tree", () => {
    const tree = buildGenericChangesTree([
      cc("src/lib/a.ts"),
      cc("src/main.ts"),
      cc("README.md"),
    ]);
    expect(tree.map((n) => n.path)).toEqual(["src", "README.md"]);
    const src = tree[0];
    if (src?.kind === "dir") {
      // Dirs first: lib before main.ts; leaves carry the payload untouched.
      expect(src.children.map((c) => c.path)).toEqual(["src/lib", "src/main.ts"]);
      const lib = src.children[0];
      if (lib?.kind === "dir") {
        const leaf = lib.children[0];
        if (leaf?.kind === "file") {
          expect(leaf.payload).toEqual({ path: "src/lib/a.ts", status: "added" });
        } else expect.unreachable();
      } else expect.unreachable();
    } else expect.unreachable();
  });

  it("keeps the payload free of FileStatus-only fields", () => {
    const tree = buildGenericChangesTree([cc("x.ts", "deleted")]);
    const node = tree[0];
    if (node?.kind === "file") {
      expect(node.payload).toEqual({ path: "x.ts", status: "deleted" });
      expect("is_staged" in node.payload).toBe(false);
    } else expect.unreachable();
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

describe("dirSelectionCounts", () => {
  const tree = buildChangesTree([
    fs("src/lib/a.ts"),
    fs("src/lib/deep/b.ts"),
    fs("src/main.ts"),
    fs("README.md"),
  ]);

  it("tallies changed + selected per directory in one pass", () => {
    const counts = dirSelectionCounts(tree, new Set(["src/lib/a.ts"]));
    expect(counts.get("src")).toEqual({ changed: 3, selected: 1 });
    expect(counts.get("src/lib")).toEqual({ changed: 2, selected: 1 });
    expect(counts.get("src/lib/deep")).toEqual({ changed: 1, selected: 0 });
  });

  it("aggregates parent selection across nested subtrees", () => {
    const counts = dirSelectionCounts(
      tree,
      new Set(["src/lib/a.ts", "src/main.ts"]),
    );
    expect(counts.get("src")?.selected).toBe(2);
    expect(counts.get("src/lib")?.selected).toBe(1);
  });

  it("yields zero tallies when nothing is selected", () => {
    const counts = dirSelectionCounts(tree, new Set());
    expect(counts.get("src")).toEqual({ changed: 3, selected: 0 });
  });
});

describe("dirCheckState", () => {
  const tree = buildChangesTree([
    fs("src/lib/a.ts"),
    fs("src/lib/b.ts"),
    fs("src/main.ts"),
  ]);

  const stateFor = (selected: string[]) => {
    const counts = dirSelectionCounts(tree, new Set(selected));
    return dirCheckState(counts, "src");
  };

  it("returns all when every subtree file is selected", () => {
    expect(stateFor(["src/lib/a.ts", "src/lib/b.ts", "src/main.ts"])).toBe("all");
  });

  it("returns none when nothing is selected", () => {
    expect(stateFor([])).toBe("none");
  });

  it("returns some for partial selection", () => {
    expect(stateFor(["src/lib/a.ts"])).toBe("some");
  });

  it("returns none for unknown directories", () => {
    const counts = dirSelectionCounts(tree, new Set());
    expect(dirCheckState(counts, "nope")).toBe("none");
  });
});

describe("toggleDirSelection", () => {
  const tree = buildChangesTree([
    fs("src/lib/a.ts"),
    fs("src/lib/deep/b.ts"),
    fs("src/main.ts"),
    fs("README.md"),
  ]);

  it("selects the whole subtree from empty", () => {
    const next = toggleDirSelection(tree, "src", new Set());
    expect([...next].sort()).toEqual([
      "src/lib/a.ts",
      "src/lib/deep/b.ts",
      "src/main.ts",
    ]);
  });

  it("selects the whole subtree from partial", () => {
    const next = toggleDirSelection(tree, "src", new Set(["src/lib/a.ts"]));
    expect([...next].sort()).toEqual([
      "src/lib/a.ts",
      "src/lib/deep/b.ts",
      "src/main.ts",
    ]);
  });

  it("clears the subtree when fully selected, preserving outside paths", () => {
    const next = toggleDirSelection(
      tree,
      "src",
      new Set(["src/lib/a.ts", "src/lib/deep/b.ts", "src/main.ts", "README.md"]),
    );
    expect([...next].sort()).toEqual(["README.md"]);
  });

  it("works for nested directories", () => {
    const next = toggleDirSelection(tree, "src/lib", new Set(["README.md"]));
    expect([...next].sort()).toEqual([
      "README.md",
      "src/lib/a.ts",
      "src/lib/deep/b.ts",
    ]);
  });

  it("returns a copy unchanged for unknown directories", () => {
    const input = new Set(["README.md"]);
    const next = toggleDirSelection(tree, "nope", input);
    expect(next).toEqual(input);
    expect(next).not.toBe(input);
  });
});
