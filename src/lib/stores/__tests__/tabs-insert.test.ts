import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/api/tauri", () => ({
  terminalSpawn: vi.fn().mockResolvedValue(100),
  terminalKill: vi.fn().mockResolvedValue(undefined),
  terminalSetActive: vi.fn().mockResolvedValue(undefined),
  aiLaunchInteractive: vi.fn().mockResolvedValue(200),
  reorderProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/stores/terminal", () => ({
  onTerminalOutput: vi.fn(),
  offTerminalOutput: vi.fn(),
}));

import {
  openTabs,
  activeTabIndex,
  addProjectTab,
  tabIndexToProjectIndex,
} from "$lib/stores/tabs";
import type { ProjectInfo, Tab } from "$lib/types";

function project(name: string, path: string): ProjectInfo {
  return {
    path,
    name,
    head_branch: "main",
    change_count: 0,
    is_worktree: false,
  };
}

function resetTabs() {
  openTabs.set([]);
  activeTabIndex.set(-1);
}

describe("addProjectTab insertion position", () => {
  beforeEach(() => {
    resetTabs();
  });

  it("appends when there is no active tab", () => {
    const idx = addProjectTab(project("A", "/tmp/A"));
    expect(idx).toBe(0);
    expect(get(openTabs)).toHaveLength(1);
  });

  it("inserts immediately to the right of the active project tab", () => {
    addProjectTab(project("A", "/tmp/A"));
    addProjectTab(project("C", "/tmp/C"));
    activeTabIndex.set(0);

    const idx = addProjectTab(project("B", "/tmp/B"));

    const tabs = get(openTabs);
    expect(idx).toBe(1);
    expect(tabs.map((t) => (t.kind === "project" ? t.project.name : "?"))).toEqual([
      "A",
      "B",
      "C",
    ]);
    // Active stays on A until switchToTab runs.
    expect(get(activeTabIndex)).toBe(0);
  });

  it("inserts after a composite tab", () => {
    openTabs.set([
      {
        kind: "composite",
        project: project("A", "/tmp/A"),
        segments: [
          {
            type: "terminal",
            info: { sessionId: 1, title: "term", cwd: "/tmp/A" },
          },
        ],
        activeSegmentIndex: 0,
      },
      { kind: "project", project: project("C", "/tmp/C") },
    ]);
    activeTabIndex.set(0);

    const idx = addProjectTab(project("B", "/tmp/B"));
    const tabs = get(openTabs);

    expect(idx).toBe(1);
    expect(tabs[0].kind).toBe("composite");
    expect(tabs[1].kind).toBe("project");
    expect(tabs[2].kind).toBe("project");
    // Project-index mapping follows the new order.
    expect(tabIndexToProjectIndex(1)).toBe(1);
  });

  it("keeps project indices consistent after mid-bar insert", () => {
    addProjectTab(project("A", "/tmp/A"));
    addProjectTab(project("C", "/tmp/C"));
    openTabs.update((tabs) => [
      ...tabs,
      {
        kind: "terminal" as const,
        terminal: { sessionId: 9, title: "shell", cwd: "/tmp" },
      },
    ]);
    activeTabIndex.set(1); // on C

    const idx = addProjectTab(project("B", "/tmp/B"));
    const tabs: Tab[] = get(openTabs);

    expect(idx).toBe(2);
    expect(tabs.map((t) => t.kind)).toEqual(["project", "project", "project", "terminal"]);
    expect(tabIndexToProjectIndex(0)).toBe(0); // A
    expect(tabIndexToProjectIndex(1)).toBe(1); // C
    expect(tabIndexToProjectIndex(2)).toBe(2); // B
    expect(tabs[2].kind === "project" && tabs[2].project.path).toBe("/tmp/B");
  });
});
