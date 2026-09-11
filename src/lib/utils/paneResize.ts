/**
 * Arithmetic behind every draggable pane edge in the app.
 *
 * Kept out of `ResizeHandle.svelte` so the clamping rules can be tested
 * without a DOM: the handle is the only place that knows about pointer
 * events, this module is the only place that knows what a legal size is.
 *
 * The rules are small but they are not obvious, and each one was a real
 * defect somewhere in the app before it was shared:
 *
 *   - `min` can exceed `max` on a small window (a 150px-minimum panel in a
 *     100px-tall viewport). A naive `Math.max(min, Math.min(max, w))` then
 *     returns `min` — i.e. *bigger* than the cap it was just clamped to —
 *     and the pane overflows the window it was supposed to fit in.
 *   - Bounds are frequently not constants: "80% of my container" and
 *     "15% of the window" both have to be measured at interaction time,
 *     because the same window drag that resizes the pane resizes the bound.
 */

/** px moved per arrow-key press, matching the other keyboard-resizable panes. */
export const PANE_RESIZE_STEP = 20;

/**
 * A pane bound: a fixed number, or a measurement taken on demand.
 *
 * Both ends take one. Dynamic *maxima* are the common case ("80% of my
 * container"); `SplitView` also has a proportional minimum, so a list pane
 * stays usable on a 4K window instead of collapsing to a strip.
 */
export type PaneBound = number | (() => number);

/** Which way the handle runs. Vertical handles size a column, horizontal a row. */
export type PaneOrientation = "vertical" | "horizontal";

export interface PaneLimits {
  min: PaneBound;
  max: PaneBound;
  /** px per arrow key. Defaults to {@link PANE_RESIZE_STEP}. */
  step?: number;
  /** True when the sized pane sits *after* the handle: +x/+y grows the gap. */
  inverted?: boolean;
  orientation?: PaneOrientation;
}

/** Resolve a bound, calling the measurement function when one was given. */
export function resolveBound(bound: PaneBound): number {
  return typeof bound === "function" ? bound() : bound;
}

/**
 * Clamp `size` into `[min, max]`.
 *
 * When the range is empty (`min > max`) the upper bound wins: keeping the
 * pane inside the space it has beats honouring a minimum that cannot fit,
 * and it is the caller's layout that breaks if we do it the other way round.
 */
export function clampPaneWidth(size: number, min: PaneBound, max: PaneBound): number {
  const lo = resolveBound(min);
  const hi = resolveBound(max);
  return Math.max(Math.min(lo, hi), Math.min(hi, size));
}

/** What a keypress on a focused resize handle should do. */
export type PaneKeyAction = { kind: "resize"; width: number } | { kind: "reset" } | null;

/**
 * Map an arrow/Home key to a resize action, or `null` when the key is not
 * ours (so the caller can let it bubble).
 *
 * `inverted` flips the arrows along with the pane: for a pane docked to the
 * right (or the bottom) of its handle, moving the handle right *shrinks* it,
 * and a handle whose arrows do the opposite of its drag is worse than one
 * with no keyboard support at all.
 */
export function paneKeyAction(key: string, current: number, limits: PaneLimits): PaneKeyAction {
  const { min, max, step = PANE_RESIZE_STEP, inverted = false } = limits;
  const orientation = limits.orientation ?? "vertical";
  const back = orientation === "horizontal" ? "ArrowUp" : "ArrowLeft";
  const forward = orientation === "horizontal" ? "ArrowDown" : "ArrowRight";

  if (key === "Home") return { kind: "reset" };

  let delta: number | null = null;
  if (key === back) delta = -step;
  else if (key === forward) delta = step;
  if (delta === null) return null;

  // Inverted panes grow when the pointer moves toward the negative axis.
  const signed = inverted ? -delta : delta;
  return { kind: "resize", width: clampPaneWidth(current + signed, min, max) };
}
