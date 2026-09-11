/**
 * Tests for the pane-resize arithmetic shared by every draggable edge.
 *
 * The interesting cases are the ones the four hand-rolled versions got
 * wrong: an empty range on a small window, and the inverted panes (commit
 * detail on the right, diff panel at the bottom) whose arrows have to move
 * opposite to their drag.
 */

import { describe, expect, it, vi } from "vitest";
import {
  clampPaneWidth,
  paneKeyAction,
  PANE_RESIZE_STEP,
  resolveBound,
  type PaneLimits,
} from "./paneResize";

const LIMITS: PaneLimits = { min: 200, max: 600 };

describe("resolveBound", () => {
  it("passes a fixed bound through", () => {
    expect(resolveBound(480)).toBe(480);
  });

  it("calls a measurement function each time", () => {
    const measure = vi.fn(() => 512);
    expect(resolveBound(measure)).toBe(512);
    expect(resolveBound(measure)).toBe(512);
    expect(measure).toHaveBeenCalledTimes(2);
  });
});

describe("clampPaneWidth", () => {
  it("leaves in-range widths alone", () => {
    expect(clampPaneWidth(320, 200, 600)).toBe(320);
  });

  it("clamps to the minimum and the maximum", () => {
    expect(clampPaneWidth(10, 200, 600)).toBe(200);
    expect(clampPaneWidth(9000, 200, 600)).toBe(600);
  });

  it("prefers the upper bound when the range is empty", () => {
    // 150px minimum inside a container that only has 90px left: returning
    // the minimum would overflow the window the cap exists to protect.
    expect(clampPaneWidth(400, 150, 90)).toBe(90);
    expect(clampPaneWidth(10, 150, 90)).toBe(90);
  });

  it("takes a measured minimum too", () => {
    let window = 1000;
    const min = () => window * 0.15;
    expect(clampPaneWidth(100, 220, 2000)).toBe(220);
    expect(clampPaneWidth(100, min, 2000)).toBe(150);
    window = 3000;
    expect(clampPaneWidth(100, min, 2000)).toBe(450);
  });

  it("resolves a measured maximum on every call", () => {
    let container = 1000;
    const max = () => container * 0.8;
    expect(clampPaneWidth(900, 200, max)).toBe(800);
    container = 400;
    expect(clampPaneWidth(900, 200, max)).toBe(320);
  });
});

describe("paneKeyAction", () => {
  it("ignores keys that are not ours", () => {
    expect(paneKeyAction("a", 300, LIMITS)).toBeNull();
    expect(paneKeyAction("ArrowUp", 300, LIMITS)).toBeNull();
  });

  it("nudges a left-docked pane right to grow, left to shrink", () => {
    expect(paneKeyAction("ArrowRight", 300, LIMITS)).toEqual({
      kind: "resize",
      width: 300 + PANE_RESIZE_STEP,
    });
    expect(paneKeyAction("ArrowLeft", 300, LIMITS)).toEqual({
      kind: "resize",
      width: 300 - PANE_RESIZE_STEP,
    });
  });

  it("inverts the arrows for a pane docked after the handle", () => {
    const inverted = { ...LIMITS, inverted: true };
    // The commit detail pane is to the right of its handle: moving that
    // handle left is what makes the pane wider.
    expect(paneKeyAction("ArrowLeft", 340, inverted)).toEqual({
      kind: "resize",
      width: 340 + PANE_RESIZE_STEP,
    });
    expect(paneKeyAction("ArrowRight", 340, inverted)).toEqual({
      kind: "resize",
      width: 340 - PANE_RESIZE_STEP,
    });
  });

  it("uses the vertical axis keys for a horizontal handle", () => {
    const row = { ...LIMITS, inverted: true, orientation: "horizontal" as const };
    // The diff panel sits below its handle: dragging up grows it, so
    // ArrowUp has to grow it too.
    expect(paneKeyAction("ArrowUp", 250, row)).toEqual({
      kind: "resize",
      width: 250 + PANE_RESIZE_STEP,
    });
    expect(paneKeyAction("ArrowDown", 250, row)).toEqual({
      kind: "resize",
      width: 250 - PANE_RESIZE_STEP,
    });
    // The column keys do nothing on a row handle.
    expect(paneKeyAction("ArrowLeft", 250, row)).toBeNull();
  });

  it("clamps nudges at both bounds", () => {
    expect(paneKeyAction("ArrowLeft", 205, LIMITS)).toEqual({ kind: "resize", width: 200 });
    expect(paneKeyAction("ArrowRight", 595, LIMITS)).toEqual({ kind: "resize", width: 600 });
  });

  it("clamps nudges against measured bounds", () => {
    const measured = { min: () => 240, max: () => 480 };
    expect(paneKeyAction("ArrowLeft", 245, measured)).toEqual({ kind: "resize", width: 240 });
    expect(paneKeyAction("ArrowRight", 475, measured)).toEqual({ kind: "resize", width: 480 });
  });

  it("honours a custom step", () => {
    expect(paneKeyAction("ArrowRight", 300, { ...LIMITS, step: 5 })).toEqual({
      kind: "resize",
      width: 305,
    });
  });

  it("treats Home as a reset", () => {
    expect(paneKeyAction("Home", 320, LIMITS)).toEqual({ kind: "reset" });
  });
});
