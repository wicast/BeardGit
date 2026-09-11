<!--
  ResizeHandle — the one draggable edge in the app.

  Every resizable pane used to carry its own copy of this: the Changes
  column, the bottom diff panel, `SplitView`'s two panes, and the AI config
  column. Four implementations of one interaction drift, and these had: only
  two answered the keyboard, only two reset on double-click, they clamped
  with three different formulas (one of them wrong at small window sizes)
  and they hovered in three different colours. The colour divergence is
  written up in `lib/styles/resize-handle.css`; this component is the
  behaviour half of the same fix.

  What the caller keeps: the pane's markup, its width value, and where the
  seam is. What this owns: pointer tracking, clamping, keyboard, reset, and
  the drag state that lights the handle up.

  ── The two contracts ────────────────────────────────────────────────────

  1. `size` is `null` until the user has actually dragged. `null` means
     "whatever the CSS says" — the nav sidebar and the commit detail pane
     both default to a responsive `clamp()`, and freezing that into a px
     number on mount would silently turn a fluid layout into a fixed one
     (and move every visual baseline that renders at another width). The
     caller renders `--pane-x` from it, falling back to its own CSS default.
     Dragging measures the pane as it stands, so the first drag continues
     from the clamp's current value instead of jumping.

  2. The pane this sizes is the handle's adjacent sibling — previous for a
     pane docked left of the handle, next for one docked right of it or
     below it. That is the only way to know the rendered width while `size`
     is still `null`, and it costs the caller nothing: the alternative is a
     `bind:this` per pane plus a `getSize` closure.

  Keyboard: arrows nudge by `step`, Home resets. Both go through the same
  clamp as the drag, so a pane cannot be keyboard-nudged out of bounds.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    clampPaneWidth,
    paneKeyAction,
    resolveBound,
    PANE_RESIZE_STEP,
    type PaneBound,
    type PaneOrientation,
  } from "$lib/utils/paneResize";

  interface Props {
    /**
     * Pane size in px, or `null` while the pane still follows its CSS
     * default.
     */
    size: number | null;
    /**
     * Called with the new size on every drag move / arrow key, and with
     * `defaultSize` on reset. A callback rather than `bind:` because most
     * callers keep the number in a `remembered()` store — the width has to
     * outlive the component — and `bind:` only takes `$state`.
     */
    onSizeChange?: (next: number | null) => void;
    /** Lower bound in px — a number, or a measurement taken per interaction. */
    min: PaneBound;
    /** Upper bound in px — a number, or a measurement taken per interaction. */
    max: PaneBound;
    /** Accessible name for the separator. */
    label: string;
    /** Value restored by double-click and Home. Defaults to `null` (CSS default). */
    defaultSize?: number | null;
    /** px per arrow key. */
    step?: number;
    /** "horizontal" sizes a row (the bottom diff panel); default sizes a column. */
    orientation?: PaneOrientation;
    /**
     * Anchor for a vertical handle: `"left"` when the pane sits before the
     * handle, `"right"` when it sits after it (the commit detail pane).
     */
    anchor?: "left" | "right";
    /** `data-testid` for tests that drive the handle. */
    testid?: string;
  }

  let {
    size,
    onSizeChange,
    min,
    max,
    label,
    defaultSize = null,
    step = PANE_RESIZE_STEP,
    orientation = "vertical",
    anchor = "left",
    testid,
  }: Props = $props();

  let handleEl: HTMLDivElement | undefined = $state();
  let dragging = $state(false);
  /** Tear-down for an in-flight drag, so an unmount mid-drag can't leak listeners. */
  let dragCleanup: (() => void) | null = null;

  /**
   * True when the sized pane is the handle's *next* sibling.
   *
   * One flag drives all three behaviours that have to agree: which sibling
   * is measured, which way the pointer grows the pane, and which arrow key
   * grows it. When they disagreed — the original four handles each picked
   * their own convention — the arrows moved a pane the opposite way to the
   * drag.
   */
  const paneIsAfter = $derived(orientation === "horizontal" || anchor === "right");

  /** The pane this handle sizes — see contract 2 in the header comment. */
  function paneEl(): HTMLElement | null {
    const sibling = paneIsAfter ? handleEl?.nextElementSibling : handleEl?.previousElementSibling;
    return (sibling as HTMLElement | null) ?? null;
  }

  /** Current pane size: the user's value, or the pane as currently rendered. */
  function currentSize(): number {
    if (size !== null) return size;
    const el = paneEl();
    if (!el) return resolveBound(min);
    const rect = el.getBoundingClientRect();
    return orientation === "horizontal" ? rect.height : rect.width;
  }

  /**
   * Pointer movement in px, signed so that positive always *grows* the pane.
   *
   * The horizontal axis is flipped on purpose: dragging up grows a pane
   * that sits below the handle (`startY - clientY`), while dragging right
   * grows one that sits left of it. Only the vertical case can be written
   * as `clientX - startX`, and that asymmetry is exactly what made the
   * hand-rolled versions disagree.
   */
  function growDelta(ev: MouseEvent, startX: number, startY: number): number {
    if (orientation === "horizontal") {
      const up = startY - ev.clientY;
      return paneIsAfter ? up : -up;
    }
    const right = ev.clientX - startX;
    return paneIsAfter ? -right : right;
  }

  function apply(next: number) {
    onSizeChange?.(clampPaneWidth(next, min, max));
  }

  function reset() {
    onSizeChange?.(defaultSize);
  }

  function startDrag(e: MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    // Measured once, at grab time: the pane's own position must not feed
    // back into the pointer delta, or a drag that outruns the clamp
    // accumulates the difference and the pane lags behind the cursor.
    const startSize = currentSize();
    dragging = true;
    // Focus explicitly. `preventDefault()` above is there to stop the drag
    // from selecting text, and it also suppresses the browser's own
    // focus-on-mousedown — so without this the handle's `tabindex` is
    // reachable only by Tab, and every keyboard binding (arrows, Home) is
    // dead for anyone who got here with the pointer. Focusing during a
    // mousedown does not raise the `:focus-visible` ring, so a click still
    // looks like a plain grab.
    handleEl?.focus();

    const onMove = (ev: MouseEvent) => {
      apply(startSize + growDelta(ev, startX, startY));
    };
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      dragging = false;
      dragCleanup = null;
    };

    dragCleanup = stop;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  }

  function handleKeydown(e: KeyboardEvent) {
    const action = paneKeyAction(e.key, currentSize(), {
      min,
      max,
      step,
      inverted: paneIsAfter,
      orientation,
    });
    if (!action) return;
    e.preventDefault();
    if (action.kind === "reset") reset();
    else apply(action.width);
  }

  onDestroy(() => dragCleanup?.());
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={handleEl}
  class="resize-handle"
  class:resize-handle--horizontal={orientation === "horizontal"}
  class:resize-handle--anchor-left={orientation === "vertical" && anchor === "left"}
  class:resize-handle--anchor-right={orientation === "vertical" && anchor === "right"}
  class:is-dragging={dragging}
  role="separator"
  aria-orientation={orientation === "horizontal" ? "horizontal" : "vertical"}
  aria-label={label}
  tabindex="0"
  data-testid={testid}
  onmousedown={startDrag}
  ondblclick={reset}
  onkeydown={handleKeydown}
></div>
