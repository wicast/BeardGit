import { describe, it, expect } from "vitest";
import { shellLabel } from "./shell-label";
import * as m from "$lib/paraglide/messages";

describe("shellLabel", () => {
  it("maps every well-known Windows kind to localized copy", () => {
    expect(shellLabel({ kind: "cmd", path: "C:\\Windows\\System32\\cmd.exe" })).toBe(
      m.terminal_shell_cmd(),
    );
    expect(
      shellLabel({
        kind: "powershell",
        path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }),
    ).toBe(m.terminal_shell_powershell());
    expect(shellLabel({ kind: "pwsh", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" })).toBe(
      m.terminal_shell_pwsh(),
    );
    expect(shellLabel({ kind: "git-bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" })).toBe(
      m.terminal_shell_git_bash(),
    );
  });

  it("falls back to the binary basename for kinds it does not know", () => {
    expect(shellLabel({ kind: "zsh", path: "/bin/zsh" })).toBe("zsh");
    expect(shellLabel({ kind: "fish", path: "/usr/local/bin/fish" })).toBe("fish");
  });

  it("splits Windows paths on the native separator too", () => {
    expect(shellLabel({ kind: "nu", path: "C:\\Tools\\nu.exe" })).toBe("nu.exe");
  });

  it("uses the kind when the path has no basename", () => {
    expect(shellLabel({ kind: "zsh", path: "/" })).toBe("zsh");
  });
});
