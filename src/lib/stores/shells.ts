/**
 * Shell picker store — the shells the terminal can be opened with.
 *
 * The backend discovers binaries from fixed system locations and `PATH`, so
 * the list is host-specific but stable for the lifetime of the process. It is
 * fetched once, lazily, on the first right-click of the toolbar terminal
 * button; failures leave the list empty and the picker then offers only the
 * system default.
 */

import { writable, get } from "svelte/store";
import { terminalListShells } from "$lib/api/tauri";
import type { ShellOption } from "$lib/types";

export const shellOptions = writable<ShellOption[]>([]);

/** In-flight load shared by concurrent callers of {@link ensureShellsLoaded}. */
let loader: Promise<void> | null = null;

/** Block until the shell list is in the store. Idempotent. */
export async function ensureShellsLoaded(): Promise<void> {
  if (get(shellOptions).length > 0) return;
  if (!loader) {
    loader = (async () => {
      try {
        shellOptions.set((await terminalListShells()) ?? []);
      } catch {
        // Leave the list empty — the picker still offers the default shell.
      } finally {
        loader = null;
      }
    })();
  }
  await loader;
}
