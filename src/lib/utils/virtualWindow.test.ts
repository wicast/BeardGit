import { describe, expect, it } from "vitest";
import { computeVirtualWindow, virtualRowStyle } from "./virtualWindow";

const base = {
  count: 10_000,
  rowHeight: 24,
  scrollTop: 0,
  viewportHeight: 480,
  threshold: 500,
};

describe("computeVirtualWindow", () => {
  it("opts out without a uniform row height", () => {
    expect(computeVirtualWindow({ ...base, rowHeight: undefined })).toBeNull();
    expect(computeVirtualWindow({ ...base, rowHeight: 0 })).toBeNull();
  });

  it("opts out at or below the threshold", () => {
    expect(computeVirtualWindow({ ...base, count: 500 })).toBeNull();
    expect(computeVirtualWindow({ ...base, count: 501 })).not.toBeNull();
  });

  it("mounts a viewport's worth plus overscan, not the whole list", () => {
    const w = computeVirtualWindow(base)!;
    // 480 / 24 = 20 visible, + 6 overscan above and below.
    expect(w.end - w.start).toBe(32);
    expect(w.start).toBe(0);
    expect(w.totalHeight).toBe(240_000);
  });

  it("does not scroll past the start", () => {
    const w = computeVirtualWindow({ ...base, scrollTop: 0 })!;
    expect(w.start).toBe(0);
  });

  it("follows the scroll offset", () => {
    const w = computeVirtualWindow({ ...base, scrollTop: 2400 })!;
    // Row 100 is at the top; overscan pulls the mount point back by 6.
    expect(w.start).toBe(94);
  });

  it("clamps the end to the item count at the bottom", () => {
    const w = computeVirtualWindow({ ...base, scrollTop: 24 * 9_999 })!;
    expect(w.end).toBe(10_000);
    expect(w.start).toBeLessThan(10_000);
  });

  it("still returns a usable window before the viewport is measured", () => {
    // First paint: nothing has been measured yet, so the assumed height has
    // to produce a non-empty window or the list renders blank.
    const w = computeVirtualWindow({ ...base, viewportHeight: 0 })!;
    expect(w.end).toBeGreaterThan(w.start);
  });

  it("keeps the window inside the list when count is just over threshold", () => {
    const w = computeVirtualWindow({ ...base, count: 501, scrollTop: 0 })!;
    expect(w.start).toBe(0);
    expect(w.end).toBeLessThanOrEqual(501);
  });
});

describe("virtualRowStyle", () => {
  it("anchors a row at its absolute offset", () => {
    expect(virtualRowStyle(3, 24)).toContain("top: 72px");
    expect(virtualRowStyle(3, 24)).toContain("height: 24px");
  });

  it("stretches a row across the sizer by default", () => {
    const style = virtualRowStyle(0, 26);
    expect(style).toContain("left: 0");
    expect(style).toContain("right: 0");
    expect(style).not.toContain("width:");
  });

  // A windowed tree row has no class-level width to inherit, so the
  // sideways-scroll contract has to survive in the inline style: `right: 0`
  // would win the width back and re-clamp a deep path to an ellipsis.
  describe("with intrinsicWidth", () => {
    const style = virtualRowStyle(2, 26, { intrinsicWidth: true });

    it("releases the right edge so the width can decide", () => {
      expect(style).toContain("right: auto");
      expect(style).not.toContain("right: 0");
    });

    it("takes the content's width, and never less than the container", () => {
      expect(style).toContain("width: max-content");
      expect(style).toContain("min-width: 100%");
    });

    it("still anchors the row at its slot", () => {
      expect(style).toContain("top: 52px");
      expect(style).toContain("height: 26px");
      expect(style).toContain("position: absolute");
    });
  });
});
