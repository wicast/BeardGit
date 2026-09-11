/**
 * `use:horizontalWheel` — sideways scrolling that works in the app's WebView.
 *
 * ── Why this is not just `overflow-x: auto` ───────────────────────────────
 *
 * Because that alone did not scroll here, and finding out why took long
 * enough to be worth writing down.
 *
 * The CSS half of this feature (`.tree-x-scroll` / `.tree-x-row` in
 * `styles/tree-scroll.css`) gives a deep row its natural width so the
 * container overflows. In the real Tauri app (WKWebView) with the pointer
 * over such a `ChangesList`:
 *
 *   - the container reported `clientWidth=303, scrollWidth=553` — the
 *     content genuinely overflowed by 250pt, and the deep path rendered in
 *     full instead of as an ellipsis, so the layout was right;
 *   - a horizontal wheel delivered a DOM `wheel` event to that element
 *     carrying `deltaX = -250`;
 *   - `scrollLeft` stayed at `0`. A trackpad swipe did nothing.
 *
 *   Two layouts were tried before settling: the row sized `width: max-content`
 *   on a block container, and the container made a column flex box so
 *   `min-width: 100%` had a definite size to resolve against. Both reported
 *   the same overflow and both left `scrollLeft` at `0`. Two dead ends that
 *   each cost a build-and-look cycle — worth skipping if this is ever
 *   revisited.
 *
 *   The event path is where the difference lies, and it is subtle enough to
 *   be worth stating precisely: assigning `scrollLeft` by hand works
 *   (`0 → 120 → 200`), including from inside the wheel handler — but the
 *   value is then reverted. The gesture has already queued WebKit's own
 *   scroll adjustment, which lands after the handler returns and overwrites
 *   it. `preventDefault()` alone does not stop that. Moving the assignment
 *   to the next frame does, because by then the adjustment has been
 *   applied and discarded.
 *
 *   So: a plain `overflow-x: auto` box is real — the scrollbar is there and
 *   draggable, and the rows are correctly sized — but the gesture most
 *   people reach for first needs this action behind it.
 *
 * ── What this does ────────────────────────────────────────────────────────
 *
 * Translates the two gestures a user will try into `scrollLeft`:
 *
 *   - a horizontal wheel / trackpad swipe (`deltaX`);
 *   - Shift + vertical wheel, which is the long-standing convention for
 *     "scroll this thing sideways" on a device with only one wheel axis.
 *
 * A horizontal delta is only claimed when the element can still move that
 * way. At either end of the range the event is left alone, so the gesture
 * bubbles to an ancestor and keeps doing whatever it would have done —
 * `preventDefault` at the end of a list is how a horizontal scroll region
 * swallows a swipe that the user aimed at something else.
 *
 * Vertical deltas are untouched unless Shift is held, so this never
 * interferes with the vertical scroller these lists usually live inside
 * (`StagingArea`'s `.file-lists`, the commit detail `<aside>`, …).
 *
 * The scrollbar is real and permanent, not an overlay that fades: `app.css`
 * styles `::-webkit-scrollbar`, and styling it is what makes WebKit use
 * classic rather than overlay scrollbars. So the bar is draggable as well,
 * and this action only has to cover the gesture.
 */

/** Pixels of `scrollLeft` per unit of wheel delta. */
const WHEEL_SCROLL_FACTOR = 1;

/** Whether `el` has somewhere to go in the given direction (-1 | 1). */
function canScroll(el: HTMLElement, direction: -1 | 1): boolean {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0) return false;
  return direction < 0 ? el.scrollLeft > 0 : el.scrollLeft < max;
}

function onWheel(event: WheelEvent): void {
  const el = event.currentTarget as HTMLElement;
  // Shift + vertical is the one-axis trackpad/mouse convention for
  // "sideways". Plain vertical must fall through untouched.
  const horizontal = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
  if (horizontal === 0) return;

  const direction = horizontal < 0 ? -1 : 1;
  if (!canScroll(el, direction)) return;

  // Claim the gesture, then move on the next frame.
  //
  // Registering the move through `requestAnimationFrame` rather than
  // assigning inline: an inline assignment lands inside the handler's own
  // dispatch — the frame WebKit is about to repaint — and the native scroll
  // adjustment the gesture already queued lands after it and wins. Verified
  // against the real app: with the move deferred, a 250-unit horizontal
  // wheel over the Changes tree took `scrollLeft` from 0 to 250, its full
  // range, on the next frame.
  event.preventDefault();
  const delta = horizontal * WHEEL_SCROLL_FACTOR;
  requestAnimationFrame(() => {
    el.scrollLeft += delta;
  });
}

/**
 * Attach to any element carrying `.tree-x-scroll`. Returns the usual action
 * `destroy` hook; the handler is `passive: false` because it calls
 * `preventDefault`, and it is registered on the element rather than on
 * `document` so it only ever sees gestures aimed at this list.
 */
export function horizontalWheel(el: HTMLElement): { destroy: () => void } {
  el.addEventListener("wheel", onWheel, { passive: false });
  return {
    destroy() {
      el.removeEventListener("wheel", onWheel);
    },
  };
}
