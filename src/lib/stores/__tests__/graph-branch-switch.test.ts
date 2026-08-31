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
    expect(get(graphViewOptions).branch).toBe("main");
    calls.length = 0;

    // 2. User switches to "All branches".
    await setGraphViewOptions({ branch: undefined });
    expect(get(graphViewOptions).branch).toBeUndefined();
    expect(calls.at(-1)?.options?.branch ?? null).toBeNull();
    calls.length = 0;

    // 3. User switches to a specific branch again. THIS is the reported failure.
    await setGraphViewOptions({ branch: "develop" });

    // The store must record "develop" as the scope...
    expect(get(graphViewOptions).branch).toBe("develop");
    // ...and it must actually forward "develop" to the backend (not null/all).
    expect(calls.at(-1)?.options?.branch).toBe("develop");
  });

  it("does not early-return when going all -> specific (structural change)", async () => {
    await setGraphViewOptions({ branch: undefined }); // all
    calls.length = 0;
    const before = get(graphViewOptions).branch; // undefined
    await setGraphViewOptions({ branch: "feature" });
    // branch was undefined, requested "feature" => must treat as structural
    expect(before).toBeUndefined();
    expect(calls.at(-1)?.options?.branch).toBe("feature");
  });
});
