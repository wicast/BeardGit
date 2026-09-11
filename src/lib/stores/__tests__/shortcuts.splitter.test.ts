/**
 * Unit tests for the bare-key shortcut guard.
 *
 * `initShortcutListener` runs in the *capture* phase on `window` and calls
 * `stopPropagation()` on a match, so any bare-key binding it claims is
 * unreachable for whatever has focus. That is correct for inputs, and it was
 * silently wrong for the draggable pane edges: `Home` is `graph.first`, so
 * every resize handle's own Home-to-reset branch — the WAI-ARIA window
 * splitter contract — never ran, and the key jumped the graph to the first
 * commit instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initShortcutListener, registerShortcuts, unregisterShortcuts } from "$lib/stores/shortcuts";

/** Dispatch a keydown the way a real press would, from `target`. */
function press(key: string, target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

/** Put an element in the `document.activeElement` slot (jsdom does not). */
function focus(el: HTMLElement): void {
  document.body.appendChild(el);
  el.focus();
}

describe("bare-key shortcuts vs. focus owners", () => {
  let cleanup: () => void = () => {};
  const action = vi.fn();

  beforeEach(() => {
    action.mockClear();
    cleanup = initShortcutListener();
    // The same shape as `graph.first`: bare key, not marked global.
    registerShortcuts([
      { id: "graph.first", keys: { key: "Home" }, label: "First commit", category: "Graph", action },
    ]);
  });

  afterEach(() => {
    unregisterShortcuts(["graph.first"]);
    cleanup();
    document.body.innerHTML = "";
  });

  it("fires when nothing owns the key", () => {
    const event = press("Home", window);
    expect(action).toHaveBeenCalledTimes(1);
    // The listener claims the key so it cannot also scroll the container.
    expect(event.defaultPrevented).toBe(true);
  });

  it("stands down for a focused resize handle", () => {
    const handle = document.createElement("div");
    handle.setAttribute("role", "separator");
    handle.tabIndex = 0;
    focus(handle);

    const event = press("Home", handle);

    // Not swallowed, and not acted on: the handle's own handler is the only
    // thing that should see it.
    expect(action).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("stands down for a focused input", () => {
    const input = document.createElement("input");
    focus(input);

    press("Home", input);

    expect(action).not.toHaveBeenCalled();
  });

  it("still fires for a modified binding while a handle is focused", () => {
    registerShortcuts([
      {
        id: "util.test",
        keys: { mod: true, key: "Home" },
        label: "Test",
        category: "General",
        action,
      },
    ]);
    const handle = document.createElement("div");
    handle.setAttribute("role", "separator");
    handle.tabIndex = 0;
    focus(handle);

    const event = new KeyboardEvent("keydown", {
      key: "Home",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handle.dispatchEvent(event);

    // A focused pane edge must not make every shortcut unreachable — only
    // the bare keys it answers itself.
    expect(action).toHaveBeenCalledTimes(1);
    unregisterShortcuts(["util.test"]);
  });
});
