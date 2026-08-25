/**
 * Tree model for the Changes file lists (`ChangesList.svelte`) and the
 * commit-detail file list (`common/FileChangeList.svelte`).
 *
 * Pure and Svelte-free so the grouping rules stay unit-testable. The
 * backend keeps returning a flat `FileStatus[]` / `CommitFileChange[]`;
 * grouping into directories is presentation-only, computed client-side.
 * Folder-level discard reuses the existing `discard_files` command by
 * expanding a directory back into the currently-changed file paths beneath
 * it — no new backend surface. Folder CHECKBOX selection (recursive
 * select/deselect) is expressed as plain set arithmetic over the node
 * paths, so it plugs into the existing `selected: Set<string>` store with
 * zero changes to the batch stage/unstage/discard flows.
 */

import type { FileStatus } from "$lib/types";

/** A directory group in the changes tree. */
export interface ChangesTreeDir<P extends { path: string } = FileStatus> {
  kind: "dir";
  /** Directory path relative to the repo root (`"src/lib"`), no trailing slash. */
  path: string;
  /** Last segment of the path (what the row displays). */
  name: string;
  children: ChangesTreeNode<P>[];
}

/**
 * A changed-file leaf in the changes tree.
 *
 * Generic over the leaf payload so the same tree machinery serves both the
 * working-tree list (`FileStatus`) and read-only commit file lists
 * (`CommitFileChange`) without a parallel implementation.
 */
export interface ChangesTreeFile<P extends { path: string } = FileStatus> {
  kind: "file";
  /** File path relative to the repo root — identical to `payload.path`. */
  path: string;
  name: string;
  /** The original flat-list entry this leaf was built from. */
  payload: P;
}

export type ChangesTreeNode<P extends { path: string } = FileStatus> =
  | ChangesTreeDir<P>
  | ChangesTreeFile<P>;

/** A visible row of the rendered tree (expanded nodes only). */
export interface ChangesTreeRow<P extends { path: string } = FileStatus> {
  node: ChangesTreeNode<P>;
  /** Nesting depth — 0 for top-level entries. Drives the row indent. */
  depth: number;
}

function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Group a flat list of path-carrying entries into a directory prefix tree.
 *
 * Sorting is case-insensitive and directories sort before their siblings'
 * files at each level (Finder/VS Code convention). Root-level files keep
 * `kind: "file"`. Duplicate paths (shouldn't happen) collapse silently.
 */
export function buildGenericChangesTree<P extends { path: string }>(
  files: P[],
): ChangesTreeNode<P>[] {
  const roots: ChangesTreeNode<P>[] = [];
  /** Directory nodes keyed by their full path ("src", "src/lib", …). */
  const dirs = new Map<string, ChangesTreeDir<P>>();

  const ensureDir = (path: string): ChangesTreeDir<P> => {
    let node = dirs.get(path);
    if (!node) {
      const parentIdx = path.lastIndexOf("/");
      const parentPath = parentIdx === -1 ? "" : path.slice(0, parentIdx);
      node = { kind: "dir", path, name: dirName(path), children: [] };
      dirs.set(path, node);
      if (parentPath === "") {
        roots.push(node);
      } else {
        ensureDir(parentPath).children.push(node);
      }
    }
    return node;
  };

  for (const file of files) {
    const parentIdx = file.path.lastIndexOf("/");
    if (parentIdx === -1) {
      roots.push({ kind: "file", path: file.path, name: file.path, payload: file });
    } else {
      const parentPath = file.path.slice(0, parentIdx);
      ensureDir(parentPath).children.push({
        kind: "file",
        path: file.path,
        name: dirName(file.path),
        payload: file,
      });
    }
  }

  const sortNodes = (nodes: ChangesTreeNode<P>[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const n of nodes) if (n.kind === "dir") sortNodes(n.children);
  };
  sortNodes(roots);

  return roots;
}

/**
 * Build the working-tree changes tree from a flat `FileStatus[]`.
 * (Typed alias of {@link buildGenericChangesTree} for the Changes view.)
 */
export function buildChangesTree(files: FileStatus[]): ChangesTreeNode<FileStatus>[] {
  return buildGenericChangesTree(files);
}

/**
 * Flatten the tree into visible render rows, honouring the collapsed-dir
 * set. Collapsed directories appear as their own single row; everything
 * beneath them is omitted.
 */
export function flattenTree<P extends { path: string }>(
  roots: ChangesTreeNode<P>[],
  collapsedDirs: ReadonlySet<string>,
): ChangesTreeRow<P>[] {
  const rows: ChangesTreeRow<P>[] = [];
  const walk = (nodes: ChangesTreeNode<P>[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === "dir" && !collapsedDirs.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(roots, 0);
  return rows;
}

/**
 * Collect the changed-file paths currently listed beneath `dirPath`
 * (inclusive of nested levels regardless of collapse state — acting on a
 * folder affects its whole subtree, visible or not).
 */
export function changedFilesUnderDir<P extends { path: string }>(
  roots: ChangesTreeNode<P>[],
  dirPath: string,
): string[] {
  const out: string[] = [];
  const collectFiles = (dir: ChangesTreeDir<P>) => {
    for (const child of dir.children) {
      if (child.kind === "file") out.push(child.path);
      else collectFiles(child);
    }
  };
  const walk = (nodes: ChangesTreeNode<P>[]) => {
    for (const node of nodes) {
      if (node.kind === "dir") {
        if (node.path === dirPath) collectFiles(node);
        else walk(node.children);
      }
    }
  };
  walk(roots);
  return out;
}

// ─── Folder checkbox selection ───────────────────────────────────────────────

/** Per-directory changed/selected file tallies for the tree. */
export interface DirSelectionCounts {
  /** Changed files in the subtree (including nested levels). */
  changed: number;
  /** Of those, how many are currently in the `selected` set. */
  selected: number;
}

/**
 * Compute `{changed, selected}` per directory in ONE bottom-up DFS over the
 * tree — O(files) total, regardless of nesting depth. Parents aggregate
 * their children's subtrees plus their own direct files, so every directory
 * (root to leaf) gets a correct tally without per-directory walks.
 */
export function dirSelectionCounts<P extends { path: string }>(
  roots: ChangesTreeNode<P>[],
  selected: ReadonlySet<string>,
): Map<string, DirSelectionCounts> {
  const counts = new Map<string, DirSelectionCounts>();
  const walk = (nodes: ChangesTreeNode<P>[]): DirSelectionCounts => {
    let changed = 0;
    let sel = 0;
    for (const n of nodes) {
      if (n.kind === "dir") {
        const sub = walk(n.children);
        counts.set(n.path, sub);
        changed += sub.changed;
        sel += sub.selected;
      } else {
        changed += 1;
        if (selected.has(n.path)) sel += 1;
      }
    }
    return { changed, selected: sel };
  };
  walk(roots);
  return counts;
}

/** Checkbox state of a directory row, derived from its tally. */
export type DirCheckState = "all" | "some" | "none";

/**
 * Three-state checkbox state for `dirPath`. `"some"` renders indeterminate;
 * `"all"` fully checked; `"none"` (or an unknown directory) unchecked.
 * Thin Map lookup over {@link dirSelectionCounts} — callers compute the map
 * once per render pass, not per row.
 */
export function dirCheckState(
  counts: Map<string, DirSelectionCounts>,
  dirPath: string,
): DirCheckState {
  const c = counts.get(dirPath);
  if (!c || c.changed === 0 || c.selected === 0) return "none";
  return c.selected === c.changed ? "all" : "some";
}

/**
 * Recursively select/deselect every changed file beneath `dirPath`.
 *
 * Click semantics mirror a native tri-state checkbox cycle: when the whole
 * subtree is already selected → deselect it all; otherwise (none or some) →
 * select it all. Paths outside the subtree are preserved. Returns a NEW set
 * (callers write it back into the selection store); unknown directories
 * return a copy of the input unchanged.
 */
export function toggleDirSelection<P extends { path: string }>(
  roots: ChangesTreeNode<P>[],
  dirPath: string,
  selected: ReadonlySet<string>,
): Set<string> {
  const subtree = changedFilesUnderDir(roots, dirPath);
  const next = new Set(selected);
  if (subtree.length === 0) return next;
  const allSelected = subtree.every((p) => selected.has(p));
  for (const p of subtree) {
    if (allSelected) next.delete(p);
    else next.add(p);
  }
  return next;
}