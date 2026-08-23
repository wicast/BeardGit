/**
 * Tree model for the Changes file lists (`ChangesList.svelte`).
 *
 * Pure and Svelte-free so the grouping rules stay unit-testable. The
 * backend keeps returning a flat `FileStatus[]`; grouping into directories
 * is presentation-only, computed client-side. Folder-level discard reuses
 * the existing `discard_files` command by expanding a directory back into
 * the currently-changed file paths beneath it — no new backend surface.
 */

import type { FileStatus } from "$lib/types";

/** A directory group in the changes tree. */
export interface ChangesTreeDir {
  kind: "dir";
  /** Directory path relative to the repo root (`"src/lib"`), no trailing slash. */
  path: string;
  /** Last segment of the path (what the row displays). */
  name: string;
  children: ChangesTreeNode[];
}

/** A changed file leaf in the changes tree. */
export interface ChangesTreeFile {
  kind: "file";
  /** File path relative to the repo root — identical to `file.path`. */
  path: string;
  name: string;
  file: FileStatus;
}

export type ChangesTreeNode = ChangesTreeDir | ChangesTreeFile;

/** A visible row of the rendered tree (expanded nodes only). */
export interface ChangesTreeRow {
  node: ChangesTreeNode;
  /** Nesting depth — 0 for top-level entries. Drives the row indent. */
  depth: number;
}

function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Group a flat file-status list into a directory prefix tree.
 *
 * Sorting is case-insensitive and directories sort before their siblings'
 * files at each level (Finder/VS Code convention). Root-level files keep
 * `kind: "file"`. Duplicate paths (shouldn't happen) collapse silently.
 */
export function buildChangesTree(files: FileStatus[]): ChangesTreeNode[] {
  const roots: ChangesTreeNode[] = [];
  /** Directory nodes keyed by their full path ("src", "src/lib", …). */
  const dirs = new Map<string, ChangesTreeDir>();

  const ensureDir = (path: string): ChangesTreeDir => {
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
      roots.push({ kind: "file", path: file.path, name: file.path, file });
    } else {
      const parentPath = file.path.slice(0, parentIdx);
      ensureDir(parentPath).children.push({
        kind: "file",
        path: file.path,
        name: dirName(file.path),
        file,
      });
    }
  }

  const sortNodes = (nodes: ChangesTreeNode[]) => {
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
 * Flatten the tree into visible render rows, honouring the collapsed-dir
 * set. Collapsed directories appear as their own single row; everything
 * beneath them is omitted.
 */
export function flattenTree(
  roots: ChangesTreeNode[],
  collapsedDirs: ReadonlySet<string>,
): ChangesTreeRow[] {
  const rows: ChangesTreeRow[] = [];
  const walk = (nodes: ChangesTreeNode[], depth: number) => {
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
 * (inclusive of nested levels regardless of collapse state — discarding a
 * folder acts on its whole subtree, visible or not).
 */
export function changedFilesUnderDir(
  roots: ChangesTreeNode[],
  dirPath: string,
): string[] {
  const out: string[] = [];
  const collectFiles = (dir: ChangesTreeDir) => {
    for (const child of dir.children) {
      if (child.kind === "file") out.push(child.file.path);
      else collectFiles(child);
    }
  };
  const walk = (nodes: ChangesTreeNode[]) => {
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
