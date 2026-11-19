/**
 * Shell selection must reach the PTY spawn.
 *
 * The toolbar's right-click shell picker passes a discovered shell path down
 * through `openTerminalTab` / `openStandaloneTerminal`; these tests pin the
 * passthrough so a signature change can't silently drop it and leave every
 * terminal opening with the system default.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const apiMocks = vi.hoisted(() => ({
  terminalSpawn: vi.fn().mockResolvedValue(100),
  terminalKill: vi.fn().mockResolvedValue(undefined),
  aiLaunchInteractive: vi.fn().mockResolvedValue(200),
  aiResumeConversation: vi.fn().mockResolvedValue(201),
  reorderProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/api/tauri", () => apiMocks);

vi.mock("$lib/stores/terminal", () => ({
  onTerminalOutput: vi.fn(),
  offTerminalOutput: vi.fn(),
}));

import {
  openTabs,
  activeTabIndex,
  openTerminalTab,
  openStandaloneTerminal,
} from "$lib/stores/tabs";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

beforeEach(() => {
  openTabs.set([]);
  activeTabIndex.set(-1);
  apiMocks.terminalSpawn.mockClear();
});

describe("terminal shell passthrough", () => {
  it("openStandaloneTerminal forwards the chosen shell", async () => {
    await openStandaloneTerminal("/home/test", "Terminal", GIT_BASH);
    expect(apiMocks.terminalSpawn).toHaveBeenCalledWith("/home/test", 80, 24, GIT_BASH);
  });

  it("openTerminalTab forwards the chosen shell", async () => {
    await openTerminalTab("/home/test", "Terminal", GIT_BASH);
    expect(apiMocks.terminalSpawn).toHaveBeenCalledWith("/home/test", 80, 24, GIT_BASH);
  });

  it("leaves the shell unset when the caller picked none", async () => {
    await openStandaloneTerminal("/home/test", "Terminal");
    await openTerminalTab("/home/test", "Terminal");
    for (const call of apiMocks.terminalSpawn.mock.calls) {
      expect(call[3]).toBeUndefined();
    }
  });

  it("still creates the tab when a shell was chosen", async () => {
    await openStandaloneTerminal("/home/test", "Terminal", GIT_BASH);
    expect(get(openTabs)).toHaveLength(1);
    expect(get(activeTabIndex)).toBe(0);
  });
});
