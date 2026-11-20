<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal as XTerm } from "@xterm/xterm";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { SearchAddon } from "@xterm/addon-search";
  import type { ITheme } from "@xterm/xterm";
  import type { ThemeData } from "../../types";
  import { acquireInteractive, releaseInteractive } from "./interactive-pool";
  import ContextMenu from "$lib/components/common/ContextMenu.svelte";
  import type { MenuItem } from "$lib/components/common/ContextMenu.svelte";
  import * as m from "$lib/paraglide/messages";
  import {
    applyQuickEditRightClick,
    terminalRightClickBehavior,
  } from "$lib/utils/terminal-right-click";

  interface Props {
    mode: "interactive" | "readonly";
    theme: ThemeData;
    onData?: (data: string) => void;
    fontSize?: number;
    /** Path of the shell this session runs; null/undefined = system default. */
    shell?: string | null;
  }

  let { mode, theme, onData, fontSize = 13, shell = null }: Props = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let terminal: XTerm | undefined = $state();
  let fitAddon: FitAddon | undefined = $state();

  // ── Shell-specific right-click ────────────────────────────────────────
  // Windows consoles (cmd/PowerShell) use QuickEdit: right-click copies a
  // selection, or pastes when there is none. Git Bash and Unix shells open
  // a context menu instead — matching what those terminals do natively.
  const isWindows =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

  let menuVisible = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuItems = $state<MenuItem[]>([]);

  async function copySelection(): Promise<void> {
    const text = terminal?.getSelection() ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be unavailable in some webviews */
    }
  }

  async function pasteClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) terminal?.paste(text);
    } catch {
      /* clipboard read can be denied; leave the terminal untouched */
    }
  }

  function openContextMenu(): void {
    menuItems = [
      {
        label: m.terminal_menu_copy(),
        disabled: !terminal?.getSelection(),
        action: () => void copySelection(),
      },
      { label: m.terminal_menu_paste(), action: () => void pasteClipboard() },
      { label: m.terminal_menu_select_all(), action: () => terminal?.selectAll() },
    ];
    menuVisible = true;
  }

  async function handleContextMenu(e: MouseEvent): Promise<void> {
    if (mode !== "interactive" || !terminal) return;
    e.preventDefault();
    e.stopPropagation();

    if (terminalRightClickBehavior(shell, isWindows) === "quick-edit") {
      try {
        await applyQuickEditRightClick(terminal, navigator.clipboard);
      } catch {
        /* clipboard may be unavailable in some webviews */
      }
      return;
    }

    menuX = e.clientX;
    menuY = e.clientY;
    openContextMenu();
  }

  function toXtermTheme(t: ThemeData): ITheme {
    return {
      background: t.colors.background,
      foreground: t.colors.foreground,
      cursor: t.colors.blue,
      cursorAccent: t.colors.background,
      selectionBackground: t.derived.selection,
      black: t.colors.black,
      red: t.colors.red,
      green: t.colors.green,
      yellow: t.colors.yellow,
      blue: t.colors.blue,
      magenta: t.colors.magenta,
      cyan: t.colors.cyan,
      white: t.colors.white,
      brightBlack: t.colors.bright_black,
      brightRed: t.colors.bright_red,
      brightGreen: t.colors.bright_green,
      brightYellow: t.colors.bright_yellow,
      brightBlue: t.colors.bright_blue,
      brightMagenta: t.colors.bright_magenta,
      brightCyan: t.colors.bright_cyan,
      brightWhite: t.colors.bright_white,
    };
  }

  /**
   * Web fonts load asynchronously: the first `fit()` measures the fallback
   * font, and xterm never re-measures when the real font swaps in — it has
   * no `document.fonts` awareness at all. `cols` then disagrees with the
   * rendered cell width and every shell repaint (zsh's completion plugins
   * repaint on every keystroke) lands at shifted columns. Refit once the
   * font situation settles: after the current loading batch finishes, and
   * once more if another face (e.g. the Nerd Font, fetched only when a
   * prompt glyph demands it) arrives later.
   */
  function connectFontRefit(): () => void {
    const fonts = document.fonts;
    const refit = () => requestAnimationFrame(() => fitAddon?.fit());
    fonts?.ready.then(refit);
    fonts?.addEventListener("loadingdone", refit, { once: true });
    return () => fonts?.removeEventListener("loadingdone", refit);
  }

  onMount(() => {
    if (!containerEl) return;

    if (mode === "interactive") {
      // ── Interactive: acquire from pool ──
      const pooled = acquireInteractive();
      terminal = pooled.terminal;
      fitAddon = pooled.fitAddon;

      // Apply current theme and font size (pool instance may have stale values)
      terminal.options.theme = toXtermTheme(theme);
      terminal.options.fontSize = fontSize;

      terminal.open(containerEl);

      // Capture phase: handle the shell-specific right-click before xterm's
      // own handlers see the event.
      const onContextMenu = (e: MouseEvent) => void handleContextMenu(e);
      containerEl.addEventListener("contextmenu", onContextMenu, { capture: true });

      // Load WebGL addon after open (needs canvas context)
      try {
        terminal.loadAddon(new WebglAddon());
      } catch {
        // WebGL not available — fallback to canvas renderer (automatic)
      }

      fitAddon.fit();
      const disconnectFontRefit = connectFontRefit();

      if (onData) {
        terminal.onData(onData);
      }

      const observer = new ResizeObserver(() => {
        requestAnimationFrame(() => fitAddon?.fit());
      });
      observer.observe(containerEl);

      return () => {
        containerEl?.removeEventListener("contextmenu", onContextMenu, { capture: true });
        observer.disconnect();
        disconnectFontRefit();
        if (terminal && fitAddon) {
          releaseInteractive({ terminal, fitAddon });
          terminal = undefined;
          fitAddon = undefined;
        }
      };
    } else {
      // ── Read-only: create fresh instance (pool managed at higher level) ──
      terminal = new XTerm({
        theme: toXtermTheme(theme),
        fontFamily: "'Fira Code', 'NerdFontSymbols', monospace",
        fontSize,
        disableStdin: true,
        cursorBlink: false,
        scrollback: 10000,
        convertEol: true,
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.loadAddon(new SearchAddon());

      terminal.open(containerEl);

      try {
        terminal.loadAddon(new WebglAddon());
      } catch {
        // WebGL not available
      }

      fitAddon.fit();
      const disconnectFontRefit = connectFontRefit();

      if (onData) {
        terminal.onData(onData);
      }

      const observer = new ResizeObserver(() => {
        requestAnimationFrame(() => fitAddon?.fit());
      });
      observer.observe(containerEl);

      return () => {
        observer.disconnect();
        disconnectFontRefit();
        terminal?.dispose();
      };
    }
  });

  // React to theme changes
  $effect(() => {
    if (terminal && theme) {
      terminal.options.theme = toXtermTheme(theme);
    }
  });

  // Public methods exposed via bind:this
  export function write(data: string | Uint8Array): void {
    terminal?.write(data);
  }

  export function clear(): void {
    terminal?.clear();
    terminal?.reset();
  }

  export function dispose(): void {
    // Note: for interactive mode, prefer the cleanup returned by onMount
    // which calls releaseInteractive(). This method is a fallback for
    // callers that don't rely on Svelte's lifecycle cleanup.
    terminal?.dispose();
    terminal = undefined;
  }

  export function fit(): void {
    fitAddon?.fit();
  }

  export function getTerminal(): XTerm | undefined {
    return terminal;
  }
</script>

<div class="terminal-container" bind:this={containerEl} style:background={theme.colors.background}></div>

{#if mode === "interactive"}
  <ContextMenu
    items={menuItems}
    x={menuX}
    y={menuY}
    visible={menuVisible}
    onClose={() => (menuVisible = false)}
  />
{/if}

<style>
  .terminal-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .terminal-container :global(.xterm) {
    height: 100%;
  }

  .terminal-container :global(.xterm .xterm-screen),
  .terminal-container :global(.xterm .xterm-scrollable-element) {
    height: 100%;
  }
</style>
