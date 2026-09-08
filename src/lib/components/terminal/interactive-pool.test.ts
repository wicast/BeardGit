import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture rAF callbacks so tests can flush the warm-spare scheduler
// explicitly (node environment never runs frames on its own).
let rafCallbacks: FrameRequestCallback[] = [];
vi.stubGlobal(
  'requestAnimationFrame',
  (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return 0;
  },
);

// ── Mock xterm.js and addons ──
const mockTerminalInstances: Array<{
  options: Record<string, unknown>;
  loadAddon: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown>;
    loadAddon = vi.fn();
    clear = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      mockTerminalInstances.push(this as unknown as (typeof mockTerminalInstances)[number]);
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {}
  return { WebglAddon };
});

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn();
  }
  return { FitAddon };
});

vi.mock('@xterm/addon-web-links', () => {
  class WebLinksAddon {}
  return { WebLinksAddon };
});

vi.mock('@xterm/addon-search', () => {
  class SearchAddon {}
  return { SearchAddon };
});

// Must mock svelte/store's `get` since the pool reads activeTheme.
// Use importOriginal so writable/derived/readable still work for dependents.
vi.mock('svelte/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('svelte/store')>();
  return {
    ...actual,
    get: vi.fn(() => null),
  };
});

// Import pool functions AFTER mocks are registered
import {
  acquireInteractive,
  releaseInteractive,
  updateInteractivePoolTheme,
  resetInteractivePool,
  getInteractivePoolStats,
} from './interactive-pool';
import type { ThemeData } from '../../types';

describe('interactive terminal pool', () => {
  beforeEach(() => {
    mockTerminalInstances.length = 0;
    rafCallbacks = [];
    resetInteractivePool();
  });

  it('acquire returns a new instance when pool is empty', () => {
    const inst = acquireInteractive();
    expect(inst).toBeDefined();
    expect(inst.terminal).toBeDefined();
    expect(inst.fitAddon).toBeDefined();
  });

  it('acquire creates instance with interactive settings', () => {
    acquireInteractive();
    const created = mockTerminalInstances[0];
    expect(created.options.disableStdin).toBe(false);
    expect(created.options.cursorBlink).toBe(true);
  });

  it('interactive terminals do not rewrite bare LF (a live PTY speaks CRLF)', () => {
    acquireInteractive();
    expect(mockTerminalInstances[0].options.convertEol).toBe(false);
  });

  it('release always disposes the opened instance — an opened xterm can never re-open', () => {
    const inst = acquireInteractive();
    releaseInteractive(inst);
    expect(inst.terminal.dispose).toHaveBeenCalledTimes(1);
    // Disposing must not be smuggled through the warm slot either.
    expect(getInteractivePoolStats()).toEqual({ activeCount: 0, warmCount: 0 });
  });

  it('acquire after release returns a fresh instance, not the disposed one', () => {
    const first = acquireInteractive();
    releaseInteractive(first);
    const second = acquireInteractive();
    expect(second.terminal).not.toBe(first.terminal);
    expect(first.terminal.dispose).toHaveBeenCalled();
    expect(second.terminal.dispose).not.toHaveBeenCalled();
  });

  it('flushing rAF creates exactly one never-opened warm spare', () => {
    acquireInteractive();
    expect(rafCallbacks.length).toBe(1);
    rafCallbacks.forEach((cb) => cb(0));
    expect(getInteractivePoolStats()).toEqual({ activeCount: 1, warmCount: 1 });
    // The spare was created but never opened or disposed by the pool.
    const spare = mockTerminalInstances[mockTerminalInstances.length - 1];
    expect(spare.open).not.toHaveBeenCalled();
    expect(spare.dispose).not.toHaveBeenCalled();
  });

  it('the warm spare is handed out once and released instances are disposed', () => {
    const first = acquireInteractive();
    rafCallbacks.forEach((cb) => cb(0)); // create the warm spare

    const second = acquireInteractive(); // consumes the spare
    expect(getInteractivePoolStats()).toEqual({ activeCount: 2, warmCount: 0 });
    expect(second.terminal.dispose).not.toHaveBeenCalled();

    releaseInteractive(first);
    releaseInteractive(second);
    expect(getInteractivePoolStats()).toEqual({ activeCount: 0, warmCount: 0 });
  });

  it('updateInteractivePoolTheme updates the warm spare', () => {
    acquireInteractive();
    rafCallbacks.forEach((cb) => cb(0)); // create the warm spare

    /* beardgit:allow-hex: test fixture data matching ThemeData schema — not live CSS */
    const theme = {
      colors: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        blue: '#569cd6',
        black: '#000',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#d7ba7d',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
        bright_black: '#808080',
        bright_red: '#f44747',
        bright_green: '#6a9955',
        bright_yellow: '#d7ba7d',
        bright_blue: '#569cd6',
        bright_magenta: '#c586c0',
        bright_cyan: '#4ec9b0',
        bright_white: '#ffffff',
      },
      derived: { selection: '#264f78' },
    } as unknown as ThemeData;

    const warm = mockTerminalInstances[mockTerminalInstances.length - 1];
    updateInteractivePoolTheme(theme);
    expect(warm.options.theme).toBeDefined();
  });

  it('getInteractivePoolStats returns correct counts', () => {
    expect(getInteractivePoolStats()).toEqual({ activeCount: 0, warmCount: 0 });

    const a = acquireInteractive();
    expect(getInteractivePoolStats()).toEqual({ activeCount: 1, warmCount: 0 });

    const b = acquireInteractive();
    expect(getInteractivePoolStats()).toEqual({ activeCount: 2, warmCount: 0 });

    // Released instances are disposed outright; without flushing rAF the
    // warm spare never comes into existence.
    releaseInteractive(a);
    expect(getInteractivePoolStats()).toEqual({ activeCount: 1, warmCount: 0 });

    releaseInteractive(b);
    expect(getInteractivePoolStats()).toEqual({ activeCount: 0, warmCount: 0 });
  });
});
