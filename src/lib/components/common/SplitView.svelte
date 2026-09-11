<!--
  SplitView — Resizable horizontal split panel with left/right snippets.

  Used by TagView, StashView, BranchView, and other two-pane layouts.
  The drag, clamping, keyboard and reset all come from `ResizeHandle`; this
  component only owns the layout, the width's home in `viewMemory` (the
  dragged width survives leaving the view — see `stores/viewMemory`; global
  key, because layout is not per repo) and the `repo-changed` refresh.

  The pane's width is published to the handle as `--pane-x`: one number,
  read by the handle to find the seam and by the flex child as its width, so
  the two cannot drift apart.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import type { Snippet } from "svelte";
  import { writable } from "svelte/store";
  import { remembered } from "$lib/stores/viewMemory";
  import ResizeHandle from "./ResizeHandle.svelte";
  import * as m from "$lib/paraglide/messages";

  let {
    refreshFn,
    left,
    right,
    defaultWidth = 304,
    memoryKey,
  }: {
    refreshFn: () => void | Promise<void>;
    left: Snippet;
    right: Snippet;
    /** Initial width of the left panel in px, and what a reset (double-click
     *  or Home on the handle) restores. On resize the width is clamped
     *  between 15% of the window (min 220px) and 80% of the split container. */
    defaultWidth?: number;
    /** When set, the dragged width survives leaving the view (see
     *  `stores/viewMemory`). Global key — layout is not per repo. */
    memoryKey?: string;
  } = $props();

  // svelte-ignore state_referenced_locally
  // `defaultWidth` seeds the initial width; parent-side updates are intentionally ignored
  // because the pane width becomes user-controlled once resizing starts.
  const widthStore = memoryKey
    ? remembered(memoryKey, defaultWidth)
    : writable(defaultWidth);

  let splitEl: HTMLElement | undefined = $state();

  /** The list pane keeps 15% of the window (min 220px) and the detail pane
   *  keeps 20% of the row — both measured at interaction time, since the
   *  same window drag that moves the pane moves the bounds. */
  function minWidth(): number {
    return Math.max(220, window.innerWidth * 0.15);
  }

  function maxWidth(): number {
    const containerWidth = splitEl?.clientWidth ?? window.innerWidth;
    return containerWidth * 0.8;
  }

  onMount(() => {
    refreshFn();

    const unlisten = listen("repo-changed", () => {
      refreshFn();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  });
</script>

<div class="split-view" bind:this={splitEl} style:--pane-x="{$widthStore}px">
  <div class="split-sidebar">
    {@render left()}
  </div>
  <ResizeHandle
    size={$widthStore}
    onSizeChange={(next) => widthStore.set(next ?? defaultWidth)}
    min={minWidth}
    max={maxWidth}
    defaultSize={defaultWidth}
    label={m.resize_split_pane()}
    testid="split-resize-handle"
  />
  <div class="split-main">
    {@render right()}
  </div>
</div>

<style>
  .split-view {
    display: flex;
    /* Anchor for the absolutely-positioned resize handle. */
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  /* Straddles the seam instead of sitting in it — see
     `.resize-handle--anchor-left` in lib/styles/resize-handle.css for why. */

  .split-sidebar {
    width: var(--pane-x);
    flex-shrink: 0;
    /* The separator line lives here rather than on the handle. Moving it
       onto the handle is tidier and shifts every pane by 1px under the
       global `box-sizing: border-box` — see lib/styles/resize-handle.css. */
    border-right: 1px solid var(--border);
    overflow: hidden;
  }

  .split-main {
    flex: 1;
    overflow: hidden;
  }
</style>
