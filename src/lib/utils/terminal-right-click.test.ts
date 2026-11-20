import { describe, expect, it } from "vitest";
import {
  applyQuickEditRightClick,
  terminalRightClickBehavior,
  type QuickEditClipboard,
  type QuickEditTarget,
} from "./terminal-right-click";

describe("terminalRightClickBehavior", () => {
  it("uses QuickEdit copy-or-paste for Windows console shells", () => {
    expect(terminalRightClickBehavior("C:\\Windows\\System32\\cmd.exe", true)).toBe("quick-edit");
    expect(
      terminalRightClickBehavior(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        true,
      ),
    ).toBe("quick-edit");
    expect(terminalRightClickBehavior("C:\\Program Files\\PowerShell\\7\\pwsh.exe", true)).toBe(
      "quick-edit",
    );
  });

  it("opens a context menu for Git Bash even on Windows", () => {
    expect(terminalRightClickBehavior("C:\\Program Files\\Git\\bin\\bash.exe", true)).toBe("menu");
  });

  it("opens a context menu for Unix shells", () => {
    expect(terminalRightClickBehavior("/bin/zsh", false)).toBe("menu");
    expect(terminalRightClickBehavior("/usr/bin/fish", false)).toBe("menu");
    expect(terminalRightClickBehavior("/bin/bash", false)).toBe("menu");
  });

  it("applies the default shell's semantics when no shell is recorded", () => {
    expect(terminalRightClickBehavior(null, true)).toBe("quick-edit");
    expect(terminalRightClickBehavior(undefined, true)).toBe("quick-edit");
    expect(terminalRightClickBehavior(null, false)).toBe("menu");
    expect(terminalRightClickBehavior(undefined, false)).toBe("menu");
  });

  it("ignores case and surrounding whitespace in the path", () => {
    expect(terminalRightClickBehavior("  C:\\Windows\\System32\\CMD.EXE  ", true)).toBe(
      "quick-edit",
    );
  });
});

describe("applyQuickEditRightClick", () => {
  function harness(selection: string) {
    const state = { writes: [] as string[], reads: 0, cleared: 0, pasted: [] as string[] };
    const target: QuickEditTarget = {
      getSelection: () => selection,
      clearSelection: () => {
        state.cleared += 1;
      },
      paste: (data) => {
        state.pasted.push(data);
      },
    };
    const clipboard = (clipText: string, failWrite = false): QuickEditClipboard => ({
      writeText: async (text) => {
        if (failWrite) throw new Error("denied");
        state.writes.push(text);
      },
      readText: async () => {
        state.reads += 1;
        return clipText;
      },
    });
    return { state, target, clipboard };
  }

  it("copies the selection and clears it without touching the clipboard reader", async () => {
    const { state, target, clipboard } = harness("selected text");
    await applyQuickEditRightClick(target, clipboard("unused"));
    expect(state.writes).toEqual(["selected text"]);
    expect(state.cleared).toBe(1);
    expect(state.reads).toBe(0);
    expect(state.pasted).toEqual([]);
  });

  it("pastes the clipboard when there is no selection", async () => {
    const { state, target, clipboard } = harness("");
    await applyQuickEditRightClick(target, clipboard("clipboard text"));
    expect(state.pasted).toEqual(["clipboard text"]);
    expect(state.cleared).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("does not paste when the clipboard is empty", async () => {
    const { state, target, clipboard } = harness("");
    await applyQuickEditRightClick(target, clipboard(""));
    expect(state.pasted).toEqual([]);
  });

  it("keeps the selection when the clipboard write fails", async () => {
    const { state, target, clipboard } = harness("selected text");
    await expect(applyQuickEditRightClick(target, clipboard("unused", true))).rejects.toThrow(
      "denied",
    );
    expect(state.cleared).toBe(0);
  });
});
