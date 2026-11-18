/**
 * Outside-click dismissal for the graph header's dropdown menus.
 *
 * The interesting case is not "clicked somewhere else" — it is the click that
 * lands on a control which removes itself in response. Svelte 5 commits DOM
 * updates at the end of the event handler, before the same click finishes
 * bubbling to the window, so containment alone misreads that click as an
 * outside one and the menu closes on the user's own button. This suite drives
 * the real DOM sequence rather than trusting the helper's branch order.
 */

import { describe, it, expect, afterEach } from "vitest";
import { shouldDismissDropdown } from "../GitGraph.helpers";

const mounted: HTMLElement[] = [];

/** A menu root with one child row, both in the document. */
function mountMenu(): { root: HTMLDivElement; row: HTMLButtonElement } {
  const root = document.createElement("div");
  const row = document.createElement("button");
  root.append(row);
  document.body.append(root);
  mounted.push(root);
  return { root, row };
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

describe("shouldDismissDropdown", () => {
  it("dismisses a click that lands outside the open menu", () => {
    const { root } = mountMenu();
    const elsewhere = document.createElement("span");
    document.body.append(elsewhere);
    expect(shouldDismissDropdown(root, elsewhere)).toBe(true);
    elsewhere.remove();
  });

  it("keeps the menu open for a click on one of its own rows", () => {
    const { root, row } = mountMenu();
    expect(shouldDismissDropdown(root, row)).toBe(false);
  });

  it("keeps the menu open when the clicked control removes itself mid-click", () => {
    // The search box's clear (×) button: clicking it empties the query, the
    // `{#if value}` around it goes false, and by the time this event reaches
    // the window listener the button is no longer in the document.
    const { root, row } = mountMenu();
    let dismissed = false;
    const onWindowClick = (e: MouseEvent) => {
      if (shouldDismissDropdown(root, e.target)) dismissed = true;
    };
    window.addEventListener("click", onWindowClick);
    row.addEventListener("click", () => row.remove());

    row.click();

    expect(row.isConnected).toBe(false);
    expect(dismissed).toBe(false);
    window.removeEventListener("click", onWindowClick);
  });

  it("ignores the click while the menu root is not bound yet", () => {
    const { row } = mountMenu();
    expect(shouldDismissDropdown(undefined, row)).toBe(false);
    expect(shouldDismissDropdown(null, row)).toBe(false);
  });

  it("dismisses for a target that is not an element at all", () => {
    const { root } = mountMenu();
    expect(shouldDismissDropdown(root, window)).toBe(true);
    expect(shouldDismissDropdown(root, null)).toBe(true);
  });
});
