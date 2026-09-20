/**
 * Shared "copy name / relative path / absolute path" context-menu group
 * for file-class right-click menus (Changes, commit detail, editor tree,
 * compare, tag detail).
 *
 * Paths crossing the IPC boundary are repo-relative with forward slashes
 * (git-engine's path contract). Absolute paths are formed by joining the
 * active project root; the join always uses `/` so the clipboard string
 * is stable regardless of how the root was reported.
 */

import type { MenuItem } from "$lib/components/common/ContextMenu.svelte";
import * as m from "$lib/paraglide/messages";

/** Last path segment (no trailing slash). Works for files and folders. */
export function pathBasename(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx === -1 ? clean : clean.slice(idx + 1);
}

/** Join the project root with a repo-relative path into one absolute path. */
export function joinRepoPath(
  projectRoot: string | null | undefined,
  relPath: string,
): string {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!projectRoot) return rel;
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return rel ? `${root}/${rel}` : root;
}

/**
 * The three copy actions as one contiguous menu group (no separators —
 * callers wrap the group with `{ separator: true }` before/after so it
 * sits apart from stage/reveal/blame and the like).
 */
export function copyPathMenuItems(
  path: string,
  projectRoot: string | null | undefined,
): MenuItem[] {
  const rel = path.replace(/\\/g, "/");
  const name = pathBasename(rel);
  const abs = joinRepoPath(projectRoot, rel);
  return [
    {
      label: m.context_copy_name(),
      action: () => void navigator.clipboard.writeText(name),
    },
    {
      label: m.context_copy_relative_path(),
      action: () => void navigator.clipboard.writeText(rel),
    },
    {
      label: m.context_copy_absolute_path(),
      action: () => void navigator.clipboard.writeText(abs),
    },
  ];
}
