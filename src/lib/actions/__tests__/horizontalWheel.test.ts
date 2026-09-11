/**
 * `horizontalWheel` — the gesture half of the sideways-scroll feature.
 *
 * The CSS half (`.tree-x-scroll` / `.tree-x-row`) makes the content wider
 * than its container. This action is what actually moves it, and it exists
 * because `overflow-x: auto` alone does not scroll here: measured on the
 * real Tauri app, a horizontal wheel over an overflowing list delivered
 * `deltaX = -250` to the element and left `scrollLeft` at `0`, while
 * assigning `scrollLeft` by hand moved it — and then got reverted, because
 * WebKit's own queued scroll adjustment lands after the handler returns.
 * The move therefore has to happen on the next frame, which is the part of
 * this action most likely to be "simplified" away by a future edit.
 *
 * jsdom has no layout, so the element's scroll geometry is stubbed: what is
 * under test is the decision — which deltas are claimed, when the move is
 * applied, and what happens at the ends of the range.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { horizontalWheel } from "../horizontalWheel";

/** Minimal scrollable stand-in: jsdom reports 0 for every scroll metric. */
function makeScroller(scrollWidth = 600, clientWidth = 300): HTMLElement {
  const el = document.createElement("div");
  let left = 0;
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  Object.defineProperty(el, "scrollLeft", {
    get: () => left,
    set: (v: number) => {
      left = Math.max(0, Math.min(v, scrollWidth - clientWidth));
    },
    configurable: true,
  });
  return el;
}

function wheel(el: HTMLElement, init: { deltaX?: number; deltaY?: number; shiftKey?: boolean }): WheelEvent {
  const event = new WheelEvent("wheel", {
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    shiftKey: init.shiftKey ?? false,
    cancelable: true,
    bubbles: true,
  });
  el.dispatchEvent(event);
  return event;
}

/**
 * Run the queued frame callbacks. jsdom does implement
 * `requestAnimationFrame`, but waiting on its timer would make these tests
 * flaky for no gain — the action's own callbacks are all that matter.
 */
function flushFrames(): void {
  const queued = frames.splice(0);
  for (const cb of queued) cb(performance.now());
}

let frames: FrameRequestCallback[] = [];
let realRaf: typeof requestAnimationFrame | null = null;

function interceptFrames() {
  realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;
}

function restoreFrames() {
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  realRaf = null;
  frames = [];
}

const actions: Array<{ destroy: () => void }> = [];
function attach(el: HTMLElement) {
  const action = horizontalWheel(el);
  actions.push(action);
  return action;
}

afterEach(() => {
  while (actions.length) actions.pop()!.destroy();
  restoreFrames();
});

describe("horizontalWheel", () => {
  it("moves the list on a horizontal wheel delta", () => {
    interceptFrames();
    const el = makeScroller();
    attach(el);

    const event = wheel(el, { deltaX: 120 });
    flushFrames();

    expect(el.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it("defers the move to the next frame, so WebKit cannot revert it", () => {
    // The whole reason this action is not three lines. An inline
    // assignment is overwritten by the scroll adjustment the gesture
    // already queued; the next frame is after that has been discarded.
    interceptFrames();
    const el = makeScroller();
    attach(el);

    wheel(el, { deltaX: 120 });
    expect(el.scrollLeft).toBe(0);

    flushFrames();
    expect(el.scrollLeft).toBe(120);
  });

  it("treats shift + vertical wheel as sideways", () => {
    interceptFrames();
    const el = makeScroller();
    attach(el);

    wheel(el, { deltaY: 90, shiftKey: true });
    flushFrames();

    expect(el.scrollLeft).toBe(90);
  });

  it("leaves a plain vertical wheel alone", () => {
    // These lists sit inside a taller vertical scroller; claiming the plain
    // wheel here would break scrolling the list itself.
    interceptFrames();
    const el = makeScroller();
    attach(el);

    const event = wheel(el, { deltaY: 240 });
    flushFrames();

    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not claim a gesture the list cannot use", () => {
    // Content fits: there is nothing to scroll to, so the event must fall
    // through to whatever the user was actually aiming at.
    interceptFrames();
    const el = makeScroller(300, 300);
    attach(el);

    const event = wheel(el, { deltaX: 150 });
    flushFrames();

    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not claim a push past the end it is already at", () => {
    // `scrollLeft` is 0 and the delta asks for more room to the left. This
    // is the case that masked the feature during verification: the gesture
    // was delivered and the action declined it, correctly, which looks
    // exactly like a broken scroller unless the direction is checked.
    interceptFrames();
    const el = makeScroller();
    attach(el);

    const event = wheel(el, { deltaX: -150 });

    expect(event.defaultPrevented).toBe(false);
    flushFrames();
    expect(el.scrollLeft).toBe(0);
  });

  it("lets go at the end of the range instead of swallowing the swipe", () => {
    interceptFrames();
    const el = makeScroller(400, 300); // 100px of travel
    attach(el);

    wheel(el, { deltaX: 500 });
    flushFrames();
    expect(el.scrollLeft).toBe(100);

    // Already at the far right: a further push must bubble, not be eaten.
    const past = wheel(el, { deltaX: 500 });
    expect(past.defaultPrevented).toBe(false);
    flushFrames();
    expect(el.scrollLeft).toBe(100);
  });

  it("scrolls back to the left", () => {
    interceptFrames();
    const el = makeScroller();
    attach(el);
    el.scrollLeft = 200;

    wheel(el, { deltaX: -80 });
    flushFrames();

    expect(el.scrollLeft).toBe(120);
  });

  it("stops listening once destroyed", () => {
    interceptFrames();
    const el = makeScroller();
    const action = attach(el);
    action.destroy();
    actions.pop();

    const event = wheel(el, { deltaX: 100 });
    flushFrames();

    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("only acts on its own element", () => {
    interceptFrames();
    const el = makeScroller();
    const other = makeScroller();
    attach(el);
    const spy = vi.spyOn(other, "scrollLeft", "set");

    other.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 100, cancelable: true, bubbles: true }),
    );
    flushFrames();

    expect(spy).not.toHaveBeenCalled();
    expect(el.scrollLeft).toBe(0);
  });
});
