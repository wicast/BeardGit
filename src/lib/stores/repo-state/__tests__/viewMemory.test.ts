import { describe, expect, it } from "vitest";
import { REMEMBERABLE_VIEWS, resolveViewOnSwitch } from "../viewMemory";

describe("resolveViewOnSwitch", () => {
  it("returns graph on first visit (no recorded view)", () => {
    expect(resolveViewOnSwitch(null)).toBe("graph");
    expect(resolveViewOnSwitch(undefined)).toBe("graph");
    expect(resolveViewOnSwitch("")).toBe("graph");
  });

  it("restores a rememberable view", () => {
    for (const view of ["branches", "changes", "graph", "tags", "stashes", "worktrees", "reflog", "bisect", "submodules", "editor", "requests"]) {
      expect(resolveViewOnSwitch(view)).toBe(view);
    }
  });

  it("falls back to graph for global views (settings)", () => {
    expect(resolveViewOnSwitch("settings")).toBe("graph");
  });

  it("falls back to graph for forge/provider views", () => {
    for (const view of ["pipelines", "issues", "merge-requests", "releases", "repo-config"]) {
      expect(resolveViewOnSwitch(view)).toBe("graph");
    }
  });

  it("falls back to graph for AI views (master switch can disable them)", () => {
    expect(resolveViewOnSwitch("ai-config")).toBe("graph");
    expect(resolveViewOnSwitch("ai-sessions")).toBe("graph");
  });

  it("falls back to graph for contextual views (blame/compare)", () => {
    expect(resolveViewOnSwitch("blame")).toBe("graph");
    expect(resolveViewOnSwitch("compare")).toBe("graph");
  });

  it("rememberable set contains no out-of-scope ids", () => {
    const forbidden = [
      "settings",
      "pipelines",
      "issues",
      "merge-requests",
      "releases",
      "repo-config",
      "ai-config",
      "ai-sessions",
      "blame",
      "compare",
    ];
    for (const id of forbidden) {
      expect(REMEMBERABLE_VIEWS.has(id)).toBe(false);
    }
  });
});
