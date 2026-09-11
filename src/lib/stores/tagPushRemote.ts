/**
 * Which remote a tag push goes to.
 *
 * Tags used to be hardcoded to `origin` in both places that can push them —
 * the Tags list footer ("Push all tags") and the tag detail footer — so a
 * repository with a second remote (a fork, a mirror, a vendor remote) could
 * not push tags anywhere else at all.
 *
 * Both surfaces now read this one store: one list (the repo's remotes, from
 * `stores/remotes`) and one selection between them. Two independent pickers
 * would let the footer say `upstream` while the detail pane pushed to
 * `origin`, which is exactly the kind of thing a user only discovers after
 * a tag has already landed in the wrong place.
 *
 * The preference is session-scoped (`remembered`, like every other layout
 * choice) and validated against the current repo's remotes on every read:
 * remotes are per repository, so a preference of `upstream` from another
 * project must not be sent to `git push upstream` here. When it does not
 * apply we fall back to `origin`, then to the first remote — the same order
 * a user would pick by hand.
 */

import { derived } from "svelte/store";
import { remembered } from "./viewMemory";
import { remotes } from "./remotes";

/** The remote the user last chose. Not necessarily one this repo has. */
export const preferredTagRemote = remembered<string | null>("tags.pushRemote", null);

/**
 * The remote a tag push should use, or `null` when the repo has none
 * (callers disable their push buttons in that case).
 */
export const tagPushRemote = derived([remotes, preferredTagRemote], ([$remotes, $preferred]) => {
  if ($remotes.length === 0) return null;
  if ($preferred && $remotes.some((r) => r.name === $preferred)) {
    return $preferred;
  }
  const origin = $remotes.find((r) => r.name === "origin");
  return origin ? origin.name : $remotes[0].name;
});

/** Remember an explicit choice; it applies wherever the remote exists. */
export function setTagPushRemote(name: string): void {
  preferredTagRemote.set(name);
}

/** Test helper — drop the remembered choice. */
export function __resetTagPushRemoteForTests(): void {
  preferredTagRemote.set(null);
}
