/**
 * Right-click behaviour for an interactive terminal's content area.
 *
 * Terminals do not agree on what a right-click means: Windows consoles
 * (cmd, Windows PowerShell, pwsh) implement QuickEdit — copy when a
 * selection exists, paste when it does not — while Git Bash (mintty) and
 * Unix shells open a context menu. The behaviour follows the shell that
 * was actually spawned, not the host OS alone, so a Git Bash tab on
 * Windows still gets the menu.
 */

export type TerminalRightClickBehavior = "quick-edit" | "menu";

/** Windows console hosts whose native right-click is copy-or-paste. */
const WINDOWS_CONSOLE_SHELLS = new Set(["cmd.exe", "powershell.exe", "pwsh.exe"]);

/**
 * Pick the right-click behaviour for `shellPath`.
 *
 * @param shellPath Path chosen in the shell picker; `null`/`undefined`
 *   means the system default shell.
 * @param isWindows Whether the host is Windows.
 */
export function terminalRightClickBehavior(
  shellPath: string | null | undefined,
  isWindows: boolean,
): TerminalRightClickBehavior {
  const normalized = (shellPath ?? "").trim().toLowerCase().replace(/\\/g, "/");
  if (normalized) {
    const basename = normalized.split("/").pop() ?? "";
    return WINDOWS_CONSOLE_SHELLS.has(basename) ? "quick-edit" : "menu";
  }
  // No explicit shell → the system default. On Windows that is ComSpec
  // (cmd.exe), so QuickEdit applies; elsewhere the default is a Unix shell
  // that expects a menu.
  return isWindows ? "quick-edit" : "menu";
}

/** Minimal view of an xterm instance used by {@link applyQuickEditRightClick}. */
export interface QuickEditTarget {
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
}

/** Minimal view of the async clipboard API. */
export interface QuickEditClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

/**
 * Windows-console QuickEdit semantics for a right-click: copy the current
 * selection when there is one (then clear it, as conhost does), otherwise
 * paste the clipboard into the terminal.
 *
 * Clipboard errors propagate; callers decide whether to surface them.
 */
export async function applyQuickEditRightClick(
  target: QuickEditTarget,
  clipboard: QuickEditClipboard,
): Promise<void> {
  const selection = target.getSelection();
  if (selection) {
    await clipboard.writeText(selection);
    target.clearSelection();
    return;
  }
  const text = await clipboard.readText();
  if (text) target.paste(text);
}
