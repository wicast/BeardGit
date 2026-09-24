/**
 * Ref-name parsing for fully-qualified refs.
 *
 * The backend (`git_engine::build_ref_map`) hands back qualified names —
 * `refs/heads/main`, `refs/remotes/origin/main`, `refs/tags/v1.0` — and every
 * consumer classifies ref *kind* by those prefixes. A stripped name (`v1.0`)
 * is indistinguishable from a same-named branch, so tags rendered on the
 * graph used to wear the branch badge colour. Keeping the classification in
 * one place means the graph canvas and the commit-detail badges cannot drift
 * apart.
 */

/** The four kinds the ref badges are coloured by, plus a catch-all. */
export type RefKind = "head" | "branch" | "remote" | "tag" | "other";

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";
const TAGS = "refs/tags/";
const REFS = "refs/";

/** Classify a fully-qualified ref name. */
export function refKind(ref: string): RefKind {
  if (ref === "HEAD") return "head";
  if (ref.startsWith(HEADS)) return "branch";
  if (ref.startsWith(REMOTES)) return "remote";
  if (ref.startsWith(TAGS)) return "tag";
  return "other";
}

/** The text a ref badge shows: the name with its kind prefix removed. */
export function refLabel(ref: string): string {
  switch (refKind(ref)) {
    case "branch":
      return ref.slice(HEADS.length);
    case "remote":
      return ref.slice(REMOTES.length);
    case "tag":
      return ref.slice(TAGS.length);
    default:
      // `refs/stash`, `refs/notes/HEAD`, … — drop the generic prefix so the
      // badge shows a name a user can recognise instead of a ref path.
      return ref.startsWith(REFS) ? ref.slice(REFS.length) : ref;
  }
}

/** The local branch name behind a fully-qualified ref, or `null`. */
export function refBranchName(ref: string): string | null {
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null;
}
