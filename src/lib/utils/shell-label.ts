/** Localized display names for the shells the terminal picker offers. */

import * as m from "$lib/paraglide/messages";
import type { ShellOption } from "$lib/types";

/**
 * Display name for a discovered shell.
 *
 * The backend reports a stable `kind` slug rather than copy, because every
 * user-visible string has to live in `messages/*.json`. Kinds it doesn't know
 * — a Unix shell outside the well-named set — fall back to the binary's own
 * basename, which is what a user would call it anyway.
 */
export function shellLabel(shell: ShellOption): string {
  switch (shell.kind) {
    case "cmd":
      return m.terminal_shell_cmd();
    case "powershell":
      return m.terminal_shell_powershell();
    case "pwsh":
      return m.terminal_shell_pwsh();
    case "git-bash":
      return m.terminal_shell_git_bash();
    default:
      return shell.path.split(/[\\/]/).pop() || shell.kind;
  }
}
