/**
 * Changes view presentation preference — flat list vs collapsible tree.
 *
 * Global (not per-repo): users pick one mental model for "how do I read my
 * working tree" and expect it everywhere. Persisted through the standard
 * `get/set_changes_tree_view` settings pair; the store is hydrated by
 * `StagingArea` on mount and toggled from the Changes list header.
 */

import { writable } from "svelte/store";
import * as api from "$lib/api/tauri";

/** `true` → directory tree with collapsible folders, `false` → flat list. */
export const changesTreeView = writable<boolean>(false);

/** Hydrate the persisted preference. Failure keeps the flat default. */
export async function loadChangesViewPref(): Promise<void> {
  try {
    changesTreeView.set(await api.getChangesTreeView());
  } catch {
    /* keep default */
  }
}

/** Toggle the mode and persist. */
export async function setChangesTreeView(enabled: boolean): Promise<void> {
  await api.setChangesTreeView(enabled);
  changesTreeView.set(enabled);
}
