import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

// Record the `options` argument (3rd arg) passed to getGraphViewport so we
// can assert which branch the store actually forwards for each transition.
const calls: Array<{ offset: number; options: any }> = [];
vi.mock("../../api/tauri", () => ({
  getGraphViewport: vi.fn(async (offset: number, _limit: number, options: any) => {
    calls.push({ offset, options });
    return {
      nodes: [],
      total_count: 0,
      offset,
      limit: _limit,
    };
  }),
  refreshGraphLayout: vi.fn(),
  getCommitDetail: vi.fn(),
  getCommitFiles: vi.fn(),
  getDiffBetweenCommits: vi.fn(),
  getCommitFileDiff: vi.fn(),
  getUserIdentities: vi.fn(),
  getCommitRow: vi.fn(),
  getFileAtCommit: vi.fn(),
  getFileAtCommitText: vi.fn(),
}));

import {
  setGraphViewOptions,
  resetGraphViewScope,
  graphViewOptions,
  reloadGraph,
  graphOffset,
  viewport,
  syncGraphScopeWithHead,
} from "../graph";
import { getGraphViewport } from "../../api/tauri";

describe("branch-scope switching (all -> specific)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    graphOffset.set(0);
    viewport.set(null);
    // Start detached (no active repo) — uses the detached RepoState fallback.
    graphViewOptions.set({});
  });

  it("forwards the specific branch after switching back from all-branches", async () => {
    // 1. Repo opens on its current branch (HEAD).
    resetGraphViewScope("main");
    await reloadGraph();
    expect(get(graphViewOptions).branches).toEqual(["main"]);
    calls.length = 0;

    // 2. User switches to "All branches".
    await setGraphViewOptions({ branches: [] });
    expect(get(graphViewOptions).branches).toEqual([]);
    // The store hands the API an empty selection, which the wrapper turns
    // into `null` on the wire (both mean "all refs").
    expect(calls.at(-1)?.options?.branches).toEqual([]);
    calls.length = 0;

    // 3. User switches to a specific branch again. THIS is the reported failure.
    await setGraphViewOptions({ branches: ["develop"] });

    // The store must record "develop" as the scope...
    expect(get(graphViewOptions).branches).toEqual(["develop"]);
    // ...and it must actually forward "develop" to the backend (not null/all).
    expect(calls.at(-1)?.options?.branches).toEqual(["develop"]);
  });

  it("does not early-return when going all -> specific (structural change)", async () => {
    await setGraphViewOptions({ branches: [] }); // all
    calls.length = 0;
    await setGraphViewOptions({ branches: ["feature"] });
    // Empty selection => requested "feature" => must treat as structural
    expect(calls.at(-1)?.options?.branches).toEqual(["feature"]);
  });

  it("treats adding a branch as a structural change", async () => {
    await setGraphViewOptions({ branches: ["main"] });
    calls.length = 0;
    // Right-clicking a second branch grows the selection — a different set of
    // reachable commits, so it must reload.
    await setGraphViewOptions({ branches: ["main", "dev"] });
    expect(calls.at(-1)?.options?.branches).toEqual(["main", "dev"]);
  });

  it("treats removing a branch as a structural change", async () => {
    await setGraphViewOptions({ branches: ["main", "dev"] });
    calls.length = 0;
    await setGraphViewOptions({ branches: ["main"] });
    expect(calls.at(-1)?.options?.branches).toEqual(["main"]);
  });

  it("ignores a reorder of the same selection (no reload)", async () => {
    await setGraphViewOptions({ branches: ["main", "dev"] });
    calls.length = 0;
    // The backend canonicalises (sorts + dedupes) the list before deciding
    // whether its cached layout still matches, so a reorder describes the
    // same graph. Reloading here would drop the user's scroll position and
    // selection for a view that hasn't actually changed.
    await setGraphViewOptions({ branches: ["dev", "main"] });
    expect(calls).toHaveLength(0);
    // No structural change means the store keeps the array it already had —
    // only the viewport reload is skipped, the selection is left untouched.
    expect(get(graphViewOptions).branches).toEqual(["main", "dev"]);
  });

  it("ignores a duplicate in the same selection (no reload)", async () => {
    await setGraphViewOptions({ branches: ["main"] });
    calls.length = 0;
    await setGraphViewOptions({ branches: ["main", "main"] });
    expect(calls).toHaveLength(0);
  });
});

describe("syncGraphScopeWithHead (checkout in the Branches view)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    graphOffset.set(0);
    viewport.set(null);
    graphViewOptions.set({});
  });

  it("follows HEAD when the scope was still the branch we were on", async () => {
    // Repo opened on `main`, graph auto-scoped to it, user checks out `dev`
    // in the Branches view → the graph must follow, or it keeps showing a
    // mainline the rest of the UI has already left.
    resetGraphViewScope("main");
    const changed = await syncGraphScopeWithHead("main", "dev");
    expect(changed).toBe(true);
    expect(get(graphViewOptions).branches).toEqual(["dev"]);
    // A scope change reloads from the top, so the caller must not reload again.
    expect(get(graphOffset)).toBe(0);
  });

  it("keeps a branch the user picked deliberately", async () => {
    // HEAD is `main` but the user scoped the graph to `feature-x`. A later
    // checkout to `dev` must not yank the view away from that choice.
    resetGraphViewScope("feature-x");
    const changed = await syncGraphScopeWithHead("main", "dev");
    expect(changed).toBe(false);
    expect(get(graphViewOptions).branches).toEqual(["feature-x"]);
  });

  it("keeps the all-branches view", async () => {
    // An empty selection is an explicit "show me everything", not a
    // half-set branch scope, so it does not follow HEAD. (`undefined` and
    // `[]` are the same view — `setGraphViewOptions` treats them as
    // equivalent and leaves the field as it found it.)
    graphViewOptions.set({});
    const changed = await syncGraphScopeWithHead("main", "dev");
    expect(changed).toBe(false);
    expect(get(graphViewOptions).branches ?? []).toEqual([]);
  });

  it("keeps a multi-branch selection", async () => {
    await setGraphViewOptions({ branches: ["main", "dev"] });
    const changed = await syncGraphScopeWithHead("main", "release");
    expect(changed).toBe(false);
    expect(get(graphViewOptions).branches).toEqual(["main", "dev"]);
  });

  it("falls back to all branches when checking out into detached HEAD", async () => {
    resetGraphViewScope("main");
    const changed = await syncGraphScopeWithHead("main", null);
    expect(changed).toBe(true);
    expect(get(graphViewOptions).branches).toEqual([]);
  });

  it("treats a literal \"HEAD\" as detached, not as a branch name", async () => {
    // Older backends report detached HEAD as the string "HEAD", and
    // `refs/heads/HEAD` is not a resolvable tip — scoping to it would make
    // the viewport rebuild fail and blank the canvas.
    resetGraphViewScope("main");
    const changed = await syncGraphScopeWithHead("main", "HEAD");
    expect(changed).toBe(true);
    expect(get(graphViewOptions).branches).toEqual([]);
  });

  it("is a no-op when HEAD did not actually change branch", async () => {
    // A commit on the same branch moves HEAD's OID but not its name — the
    // scope already matches, so there is nothing to rewrite.
    resetGraphViewScope("main");
    const changed = await syncGraphScopeWithHead("main", "main");
    expect(changed).toBe(false);
    expect(get(graphViewOptions).branches).toEqual(["main"]);
  });
});
