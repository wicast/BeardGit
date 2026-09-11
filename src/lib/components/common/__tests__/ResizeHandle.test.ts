/**
 * Behavioural tests for the shared resize handle.
 *
 * These cover the part of the interaction that used to differ between the
 * four hand-rolled handles: which sibling gets measured before the user has
 * dragged, which direction the pointer grows the pane, which arrow keys do
 * the same, and what a double-click restores.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import ResizeHandle from "../ResizeHandle.svelte";

afterEach(() => cleanup());

/** Render a handle and give it a sized sibling: `before` = pane on the left. */
function mountHandle(
  props: Record<string, unknown> = {},
  opts: { pane: "before" | "after" | "none"; size?: { width: number; height: number } } = {
    pane: "before",
  },
) {
  const { container } = render(ResizeHandle, {
    props: { size: null, min: 200, max: 600, label: "Resize panel", ...props },
  });
  const handle = container.querySelector(".resize-handle") as HTMLElement;
  const measured = { width: 300, height: 250, ...opts.size };

  let pane: HTMLElement | null = null;
  if (opts.pane !== "none") {
    pane = document.createElement("div");
    pane.getBoundingClientRect = () =>
      ({
        ...measured,
        top: 0,
        left: 0,
        right: measured.width,
        bottom: measured.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    if (opts.pane === "before") container.insertBefore(pane, handle);
    else container.appendChild(pane);
  }
  return { handle, pane, container };
}

describe("ResizeHandle", () => {
  it("exposes a labelled vertical separator by default", () => {
    const { handle } = mountHandle();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize panel");
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.classList.contains("resize-handle--anchor-left")).toBe(true);
  });

  it("reports a horizontal orientation for a row-sized pane", () => {
    const { handle } = mountHandle({ orientation: "horizontal" }, { pane: "after" });
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.classList.contains("resize-handle--horizontal")).toBe(true);
  });

  describe("dragging", () => {
    it("grows a left-hand pane as the pointer moves right", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle({ onSizeChange });

      await fireEvent.mouseDown(handle, { button: 0, clientX: 300, clientY: 10 });
      await fireEvent.mouseMove(window, { clientX: 350, clientY: 10 });
      await fireEvent.mouseUp(window, {});

      expect(onSizeChange).toHaveBeenCalledWith(350);
    });

    it("resumes from the pane's rendered width while size is still null", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle(
        { onSizeChange },
        { pane: "before", size: { width: 280, height: 100 } },
      );

      await fireEvent.mouseDown(handle, { button: 0, clientX: 0, clientY: 0 });
      await fireEvent.mouseMove(window, { clientX: 20, clientY: 0 });
      await fireEvent.mouseUp(window, {});

      // 280 measured + 20 dragged, not 0 + 20.
      expect(onSizeChange).toHaveBeenCalledWith(300);
    });

    it("grows a right-hand pane as the pointer moves left", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle(
        { onSizeChange, anchor: "right", size: 340 },
        { pane: "after" },
      );

      await fireEvent.mouseDown(handle, { button: 0, clientX: 300, clientY: 0 });
      await fireEvent.mouseMove(window, { clientX: 260, clientY: 0 });
      await fireEvent.mouseUp(window, {});

      expect(onSizeChange).toHaveBeenCalledWith(380);
    });

    it("grows a bottom-docked pane as the pointer moves up", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle(
        { onSizeChange, orientation: "horizontal", size: 250 },
        { pane: "after" },
      );

      await fireEvent.mouseDown(handle, { button: 0, clientX: 0, clientY: 500 });
      await fireEvent.mouseMove(window, { clientX: 0, clientY: 440 });
      await fireEvent.mouseUp(window, {});

      expect(onSizeChange).toHaveBeenCalledWith(310);
    });

    it("clamps the drag to the bounds", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle({ onSizeChange, size: 300 });

      await fireEvent.mouseDown(handle, { button: 0, clientX: 0, clientY: 0 });
      await fireEvent.mouseMove(window, { clientX: -5000, clientY: 0 });
      await fireEvent.mouseMove(window, { clientX: 5000, clientY: 0 });
      await fireEvent.mouseUp(window, {});

      expect(onSizeChange).toHaveBeenNthCalledWith(1, 200);
      expect(onSizeChange).toHaveBeenNthCalledWith(2, 600);
    });

    it("re-measures a measured bound on every move", async () => {
      const onSizeChange = vi.fn();
      let cap = 400;
      const { handle } = mountHandle({ onSizeChange, max: () => cap, size: 300 });

      await fireEvent.mouseDown(handle, { button: 0, clientX: 0, clientY: 0 });
      await fireEvent.mouseMove(window, { clientX: 1000, clientY: 0 });
      cap = 320;
      await fireEvent.mouseMove(window, { clientX: 1000, clientY: 0 });
      await fireEvent.mouseUp(window, {});

      expect(onSizeChange).toHaveBeenNthCalledWith(1, 400);
      expect(onSizeChange).toHaveBeenNthCalledWith(2, 320);
    });

    it("ignores the right mouse button", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle({ onSizeChange, size: 300 });

      await fireEvent.mouseDown(handle, { button: 2, clientX: 0, clientY: 0 });
      await fireEvent.mouseMove(window, { clientX: 100, clientY: 0 });

      expect(onSizeChange).not.toHaveBeenCalled();
    });

    it("stops responding after mouseup", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle({ onSizeChange, size: 300 });

      await fireEvent.mouseDown(handle, { button: 0, clientX: 0, clientY: 0 });
      await fireEvent.mouseMove(window, { clientX: 50, clientY: 0 });
      await fireEvent.mouseUp(window, {});
      await fireEvent.mouseMove(window, { clientX: 200, clientY: 0 });

      expect(onSizeChange).toHaveBeenCalledTimes(1);
    });

    it("marks itself as dragging for the duration", async () => {
      // The class is what lights the handle up mid-drag, when the pointer
      // has usually left the strip and `:hover` no longer applies.
      const { handle } = mountHandle({ size: 300 });

      await fireEvent.mouseDown(handle, { button: 0, clientX: 0, clientY: 0 });
      expect(handle.classList.contains("is-dragging")).toBe(true);
      await fireEvent.mouseUp(window, {});
      expect(handle.classList.contains("is-dragging")).toBe(false);
    });
  });

  describe("keyboard", () => {
    it("nudges a left-hand pane with the left/right arrows", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle({ onSizeChange, size: 300 });

      await fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(onSizeChange).toHaveBeenLastCalledWith(320);
      await fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(onSizeChange).toHaveBeenLastCalledWith(280);
    });

    it("moves a right-hand pane the same way its drag does", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle(
        { onSizeChange, anchor: "right", size: 340 },
        { pane: "after" },
      );

      // The pane is right of the handle: dragging left grows it, so
      // ArrowLeft has to grow it too.
      await fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(onSizeChange).toHaveBeenLastCalledWith(360);
      await fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(onSizeChange).toHaveBeenLastCalledWith(320);
    });

    it("uses up/down for a horizontal handle and leaves left/right alone", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle(
        { onSizeChange, orientation: "horizontal", size: 250 },
        { pane: "after" },
      );

      await fireEvent.keyDown(handle, { key: "ArrowUp" });
      expect(onSizeChange).toHaveBeenLastCalledWith(270);
      await fireEvent.keyDown(handle, { key: "ArrowDown" });
      expect(onSizeChange).toHaveBeenLastCalledWith(230);
      await fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(onSizeChange).toHaveBeenCalledTimes(2);
    });

    it("clamps keyboard nudges too", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle({ onSizeChange, size: 205 });

      await fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(onSizeChange).toHaveBeenLastCalledWith(200);
    });

    it("restores defaultSize on Home and on double-click", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle({ onSizeChange, size: 500, defaultSize: 304 });

      await fireEvent.keyDown(handle, { key: "Home" });
      expect(onSizeChange).toHaveBeenLastCalledWith(304);
      await fireEvent.doubleClick(handle);
      expect(onSizeChange).toHaveBeenCalledTimes(2);
      expect(onSizeChange).toHaveBeenLastCalledWith(304);
    });

    it("resets to null when no defaultSize was given", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle({ onSizeChange, size: 500 });

      await fireEvent.doubleClick(handle);
      expect(onSizeChange).toHaveBeenCalledWith(null);
    });

    it("nudges from the rendered width while size is still null", async () => {
      const onSizeChange = vi.fn();
      const { handle } = mountHandle(
        { onSizeChange },
        { pane: "before", size: { width: 280, height: 100 } },
      );

      await fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(onSizeChange).toHaveBeenCalledWith(300);
    });
  });
});
