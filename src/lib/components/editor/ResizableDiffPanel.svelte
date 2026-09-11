<script lang="ts">
  /**
   * ResizableDiffPanel — the bottom diff panel shell shared by every view
   * that shows a file diff under its main content (graph commit diff,
   * branch/reflog file diff, PR/MR file diff).
   *
   * Owns a single drag handle: the full-width bar on top → vertical
   * resize (height), capped at 4/5 of the window so the panel can grow
   * large while keeping the view above it usable. The panel's outer
   * edges always stick to the surrounding columns/window — horizontal
   * balance inside a diff is the DiffEditor's own centre split handle.
   *
   * Height is held in the `diffPanelSize` store so it persists across
   * view switches. The diff content is provided by the caller as
   * `children`.
   */
  import { onMount, type Snippet } from "svelte";
  import { diffPanelHeight, DIFF_PANEL_DEFAULT_HEIGHT } from "$lib/stores/diffPanelSize";
  import ResizeHandle from "$lib/components/common/ResizeHandle.svelte";
  import * as m from "$lib/paraglide/messages";

  interface Props {
    /** Centre the panel content — used for the standalone loading spinner. */
    loading?: boolean;
    children: Snippet;
  }
  let { loading = false, children }: Props = $props();

  let rowEl: HTMLDivElement;

  const MIN_HEIGHT = 150;
  /** Keep at least this many px of the view above the panel visible. */
  const VIEW_MIN_REMAINDER = 80;

  /** Upper bound for the height: 4/5 of the window, but never so tall the
   *  view above (graph/list) drops below `VIEW_MIN_REMAINDER`. */
  function maxHeight(): number {
    const winCap = window.innerHeight * 0.8;
    const container = rowEl?.parentElement;
    if (!container) return winCap;
    return Math.min(winCap, container.clientHeight - VIEW_MIN_REMAINDER);
  }

  // Clamp into [min(MIN, hi), hi]. On a very short window/container the upper
  // bound can fall below MIN; the lower bound is capped at `hi` so the result
  // never exceeds the cap (a naive max(MIN, min(hi, h)) would push it back up).
  // The handle clamps drags and arrow keys against `min`/`max` (see
  // utils/paneResize); this one is reused for the window-resize correction
  // below, so both paths land on the same numbers.
  function clampHeight(h: number): number {
    const hi = maxHeight();
    return Math.max(Math.min(MIN_HEIGHT, hi), Math.min(hi, h));
  }

  // Correct a persisted oversize value on mount and whenever the window
  // shrinks — clamping otherwise only runs inside the handle, so a panel
  // sized large in a maximized window kept its size after a resize.
  onMount(() => {
    const reclamp = () => {
      diffPanelHeight.set(clampHeight($diffPanelHeight));
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  });

</script>

<!-- Sits above the panel it sizes and stays in flow, so its 1px separator
     line keeps belonging to the panel's height budget — see
     `.resize-handle--horizontal` in lib/styles/resize-handle.css. -->
<ResizeHandle
  size={$diffPanelHeight}
  onSizeChange={(next) => diffPanelHeight.set(next ?? DIFF_PANEL_DEFAULT_HEIGHT)}
  min={MIN_HEIGHT}
  max={maxHeight}
  defaultSize={DIFF_PANEL_DEFAULT_HEIGHT}
  orientation="horizontal"
  label={m.resize_diff_panel()}
  testid="diff-panel-resize-handle"
/>

<div class="diff-row" bind:this={rowEl} style="height: {$diffPanelHeight}px">
  <div class="diff-panel" class:diff-panel-loading={loading}>
    {@render children()}
  </div>
</div>

<style>
  .diff-row {
    display: flex;
    flex-shrink: 0;
    overflow: hidden;
  }

  .diff-panel {
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  .diff-panel-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    border-top: 1px solid var(--border);
  }
</style>
