/**
 * Unit tests for `TabBar.svelte` after the toolbar rework.
 *
 * Covers:
 * - Terminal button is a plain button (no chevron / no dropdown).
 * - Right-clicking it opens a shell picker that spawns the chosen shell.
 * - AI button is hidden when no providers are installed.
 * - AI button opens a dropdown with one row per provider + a divider
 *   + a "Launch session in background…" row.
 * - Provider rows invoke `openAiTerminalTab` with the right kind.
 * - Background row invokes `requestOpenCreateBackgroundRunDialog`.
 * - Escape and outside-click close the menu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { aiProviders } from "$lib/stores/ai";
import { shellOptions } from "$lib/stores/shells";
import { openTabs, activeTabIndex } from "$lib/stores/tabs";
import {
  openCreateBackgroundRunDialogRequest,
} from "$lib/stores/aiBackground";
import type { AvailableAiProvider, ShellOption } from "$lib/types";
import * as m from "$lib/paraglide/messages";

const tabsMocks = vi.hoisted(() => ({
  openTerminalTab: vi.fn().mockResolvedValue(1),
  openStandaloneTerminal: vi.fn().mockResolvedValue(2),
  openAiTerminalTab: vi.fn().mockResolvedValue(3),
}));

vi.mock("$lib/stores/tabs", async () => {
  const actual = await vi.importActual<typeof import("$lib/stores/tabs")>(
    "$lib/stores/tabs",
  );
  return {
    ...actual,
    openTerminalTab: tabsMocks.openTerminalTab,
    openStandaloneTerminal: tabsMocks.openStandaloneTerminal,
    openAiTerminalTab: tabsMocks.openAiTerminalTab,
  };
});

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

import TabBar from "../TabBar.svelte";

const PROVIDERS: AvailableAiProvider[] = [
  { kind: "claude_code", binary_path: "/usr/local/bin/claude", version: "1.2.3" },
  { kind: "codex", binary_path: "/usr/local/bin/codex", version: null },
];

beforeEach(() => {
  aiProviders.set([]);
  shellOptions.set([]);
  openTabs.set([]);
  activeTabIndex.set(-1);
  openCreateBackgroundRunDialogRequest.set(0);
  tabsMocks.openTerminalTab.mockClear();
  tabsMocks.openStandaloneTerminal.mockClear();
  tabsMocks.openAiTerminalTab.mockClear();
});

afterEach(() => cleanup());

describe("TabBar — terminal button", () => {
  it("is a plain button (no chevron, no dropdown wrapper)", () => {
    const { container, queryByTestId } = render(TabBar);
    expect(container.querySelector(".terminal-split")).toBeNull();
    expect(container.querySelector(".terminal-right")).toBeNull();
    expect(queryByTestId("toolbar-terminal-menu")).toBeNull();
  });

  it("calls openStandaloneTerminal with the home path when no project tab is active", async () => {
    const { getByTestId } = render(TabBar);
    await fireEvent.click(getByTestId("toolbar-terminal-btn"));
    // handleTerminalClick is async (awaits a dynamic import); waitFor
    // lets microtasks settle before asserting.
    await waitFor(() =>
      expect(tabsMocks.openStandaloneTerminal).toHaveBeenCalledTimes(1),
    );
    expect(tabsMocks.openStandaloneTerminal.mock.calls[0][0]).toBe("/Users/test");
  });
});

describe("TabBar — terminal shell picker", () => {
  const SHELLS: ShellOption[] = [
    { kind: "cmd", path: "C:\\Windows\\System32\\cmd.exe" },
    { kind: "git-bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" },
  ];

  /** Rows of the open picker, in menu order (separators excluded). */
  function rows(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(".context-menu .menu-item")];
  }

  async function openPicker(
    container: HTMLElement,
    getByTestId: (id: string) => HTMLElement,
  ): Promise<void> {
    await fireEvent.contextMenu(getByTestId("toolbar-terminal-btn"), {
      clientX: 120,
      clientY: 30,
    });
    // handleTerminalContextMenu awaits the (cached) shell load first.
    await waitFor(() => expect(container.querySelector(".context-menu")).toBeTruthy());
  }

  it("stays closed until the button is right-clicked", () => {
    shellOptions.set(SHELLS);
    const { container } = render(TabBar);
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("lists the default shell plus every discovered shell", async () => {
    shellOptions.set(SHELLS);
    const { container, getByTestId } = render(TabBar);
    await openPicker(container, getByTestId);
    expect(rows(container).map((row) => row.textContent?.trim())).toEqual([
      m.terminal_shell_default(),
      m.terminal_shell_cmd(),
      m.terminal_shell_git_bash(),
    ]);
  });

  it("opens the shell the user picked", async () => {
    shellOptions.set(SHELLS);
    const { container, getByTestId } = render(TabBar);
    await openPicker(container, getByTestId);
    await fireEvent.click(rows(container)[2]);
    await waitFor(() =>
      expect(tabsMocks.openStandaloneTerminal).toHaveBeenCalledWith(
        "/Users/test",
        m.tab_terminal(),
        SHELLS[1].path,
      ),
    );
    // The picker closes itself once a row fires.
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("opens the system default from the first row", async () => {
    shellOptions.set(SHELLS);
    const { container, getByTestId } = render(TabBar);
    await openPicker(container, getByTestId);
    await fireEvent.click(rows(container)[0]);
    await waitFor(() =>
      expect(tabsMocks.openStandaloneTerminal).toHaveBeenCalledWith(
        "/Users/test",
        m.tab_terminal(),
        undefined,
      ),
    );
  });

  it("offers only the default when nothing was discovered", async () => {
    const { container, getByTestId } = render(TabBar);
    await openPicker(container, getByTestId);
    expect(rows(container).map((row) => row.textContent?.trim())).toEqual([
      m.terminal_shell_default(),
    ]);
  });

  /**
   * Regression: `onclick` used to be wired straight to `handleTerminalClick`.
   * Now that the handler takes a shell path, forwarding the `MouseEvent`
   * would send the event object to the backend as a shell.
   */
  it("does not mistake the click event for a shell on left-click", async () => {
    shellOptions.set(SHELLS);
    const { getByTestId } = render(TabBar);
    await fireEvent.click(getByTestId("toolbar-terminal-btn"));
    await waitFor(() =>
      expect(tabsMocks.openStandaloneTerminal).toHaveBeenCalledTimes(1),
    );
    expect(tabsMocks.openStandaloneTerminal.mock.calls[0][2]).toBeUndefined();
  });
});

describe("TabBar — AI dropdown", () => {
  it("is hidden when no providers are installed", () => {
    const { queryByTestId } = render(TabBar);
    expect(queryByTestId("toolbar-ai-btn")).toBeNull();
  });

  it("renders when at least one provider is installed", () => {
    aiProviders.set(PROVIDERS);
    const { getByTestId } = render(TabBar);
    expect(getByTestId("toolbar-ai-btn")).toBeTruthy();
  });

  it("toggles the menu on click with correct aria-expanded", async () => {
    aiProviders.set(PROVIDERS);
    const { getByTestId, queryByTestId } = render(TabBar);
    const btn = getByTestId("toolbar-ai-btn");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(queryByTestId("toolbar-ai-menu")).toBeNull();

    await fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(queryByTestId("toolbar-ai-menu")).toBeTruthy();

    await fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(queryByTestId("toolbar-ai-menu")).toBeNull();
  });

  it("renders one row per provider with role=menuitem and a background row", async () => {
    aiProviders.set(PROVIDERS);
    const { getByTestId, getAllByRole } = render(TabBar);
    await fireEvent.click(getByTestId("toolbar-ai-btn"));
    const items = getAllByRole("menuitem");
    // 2 providers + 1 background row = 3
    expect(items.length).toBe(3);
    expect(getByTestId("toolbar-ai-item-claude_code")).toBeTruthy();
    expect(getByTestId("toolbar-ai-item-codex")).toBeTruthy();
    expect(getByTestId("toolbar-ai-item-background")).toBeTruthy();
  });

  it("calls openAiTerminalTab with the provider kind on provider-row click", async () => {
    aiProviders.set(PROVIDERS);
    const { getByTestId } = render(TabBar);
    await fireEvent.click(getByTestId("toolbar-ai-btn"));
    await fireEvent.click(getByTestId("toolbar-ai-item-claude_code"));
    expect(tabsMocks.openAiTerminalTab).toHaveBeenCalledTimes(1);
    expect(tabsMocks.openAiTerminalTab.mock.calls[0][2]).toBe("claude_code");
  });

  it("triggers the background-run dialog signal on the background row", async () => {
    aiProviders.set(PROVIDERS);
    const prev = get(openCreateBackgroundRunDialogRequest);
    const { getByTestId } = render(TabBar);
    await fireEvent.click(getByTestId("toolbar-ai-btn"));
    await fireEvent.click(getByTestId("toolbar-ai-item-background"));
    expect(get(openCreateBackgroundRunDialogRequest)).toBe(prev + 1);
  });

  it("closes the menu on Escape", async () => {
    aiProviders.set(PROVIDERS);
    const { getByTestId, queryByTestId } = render(TabBar);
    const btn = getByTestId("toolbar-ai-btn");
    await fireEvent.click(btn);
    expect(queryByTestId("toolbar-ai-menu")).toBeTruthy();
    await fireEvent.keyDown(btn, { key: "Escape" });
    expect(queryByTestId("toolbar-ai-menu")).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the menu on outside mousedown", async () => {
    aiProviders.set(PROVIDERS);
    const { getByTestId, queryByTestId } = render(TabBar);
    await fireEvent.click(getByTestId("toolbar-ai-btn"));
    expect(queryByTestId("toolbar-ai-menu")).toBeTruthy();
    // Fire a mousedown on document.body, outside the dropdown wrapper.
    await fireEvent.mouseDown(document.body);
    expect(queryByTestId("toolbar-ai-menu")).toBeNull();
  });
});
