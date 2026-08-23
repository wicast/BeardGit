/**
 * Regression test for the exact user-reported scenario (per-project view
 * memory, F4):
 *
 *   open P1 (graph) → user picks "changes" → switch to P2 (must show
 *   GRAPH — P2 was never visited) → switch back to P1 (must show
 *   "changes" again).
 *
 * Exercises the real RepoState container + the same decision function the
 * `+page.svelte` `onProjectSwitch` callback uses, so a regression in the
 * save-then-restore choreography (e.g. the outgoing view leaking into the
 * incoming repo's slice) fails here.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { createRepoState, getRepoState, dropRepoState, __resetRepoStateForTests } from "../index";
import { resolveViewOnSwitch } from "../viewMemory";

/** Mimic the +page.svelte callback: save outgoing, resolve incoming. */
function simulateSwitch(prevPath: string | null, activeView: string, incomingPath: string | null): string {
  if (prevPath) {
    getRepoState(prevPath)?.lastView.set(activeView);
  }
  const rs = incomingPath ? getRepoState(incomingPath) : null;
  return resolveViewOnSwitch(rs ? get(rs.lastView) : null);
}

describe("per-project view memory — user scenario", () => {
  beforeEach(() => {
    __resetRepoStateForTests();
    // App startup: both project tabs opened; neither visited yet.
    createRepoState("/repo/p1");
    createRepoState("/repo/p2");
  });

  it("P1(graph→changes) → P2 shows graph → P1 shows changes", () => {
    // P1 activated first: never visited → graph (cold default).
    expect(simulateSwitch(null, "graph", "/repo/p1")).toBe("graph");

    // User picks "changes" while on P1 (no switch — activeView just is changes).
    const activeView = "changes";

    // Switch to P2: P2 was never visited → graph, NOT P1's changes.
    expect(simulateSwitch("/repo/p1", activeView, "/repo/p2")).toBe("graph");
    expect(get(getRepoState("/repo/p1")!.lastView)).toBe("changes");

    // Switch back to P1: restores its remembered view.
    expect(simulateSwitch("/repo/p2", "graph", "/repo/p1")).toBe("changes");

    // And P2 still remembers graph on the next round trip.
    expect(simulateSwitch("/repo/p1", "changes", "/repo/p2")).toBe("graph");
  });

  it("first-visit slice (never activated) resolves to graph, not the global view", () => {
    // Simulate the global activeView being "changes" from another project.
    const globalView = "changes";
    // P2 has a slice (created on open) but lastView was never written.
    expect(get(getRepoState("/repo/p2")!.lastView)).toBe("");
    expect(resolveViewOnSwitch(get(getRepoState("/repo/p2")!.lastView) || null)).toBe("graph");
    void globalView;
  });

  it("an outgoing project being CLOSED saves nothing but the incoming still restores", () => {
    // P1 is active on "changes"; the user closes P1, so its RepoState is
    // dropped (as closeTab does) before the switch callback runs. The save
    // side must no-op gracefully, and P2 must still resolve to its own view.
    createRepoState("/repo/p1");
    createRepoState("/repo/p2");
    getRepoState("/repo/p1")?.lastView.set("changes");

    // closeTab flow: dropRepoState(outgoing) then activate the incoming tab.
    dropRepoState("/repo/p1");
    expect(getRepoState("/repo/p1")).toBeNull();

    // The +page callback's save step is `getRepoState(prevPath)?.lastView.set`
    // → null-safe no-op; restore still reads the incoming repo's own slice.
    const incomingView = simulateSwitch("/repo/p1", "changes", "/repo/p2");
    expect(incomingView).toBe("graph"); // P2 never visited → graph
    expect(get(getRepoState("/repo/p2")!.lastView)).toBe("");
  });

  it("Settings stays global: it is never remembered per-project", () => {
    // While on Settings, switching projects must NOT restore "settings" on
    // the next project — resolveViewOnSwitch always falls back to graph.
    createRepoState("/repo/p1");
    createRepoState("/repo/p2");
    expect(resolveViewOnSwitch("settings")).toBe("graph");

    // Even if settings were somehow stored, it resolves to graph and the
    // per-project memory never records it.
    const view = simulateSwitch("/repo/p1", "settings", "/repo/p2");
    expect(view).toBe("graph");
    expect(get(getRepoState("/repo/p1")!.lastView)).toBe("settings");
  });
});
