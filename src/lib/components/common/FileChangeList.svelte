<!--
  FileChangeList — Selectable file list with status icons and path highlighting.

  Shared component used by tag detail, graph commit detail, stash detail,
  and branch commit detail. Displays repo-relative paths with directory
  portions dimmed and the filename highlighted. Emits `onSelect` when a
  file is clicked.

  Tree mode (opt-in via `treeToggle`): groups the flat list into collapsible
  directory rows built with the same tree model as the Changes view
  (`buildGenericChangesTree` + `flattenTree`). The flat/tree mode and the
  collapsed-dir set are component-local — read-only commit file lists are
  not tied to the working-tree `changesTreeView` preference. Either way the
  rows are flattened into one `{node, depth}` array, so the virtual window
  is computed over the same array in both modes.
-->
<script lang="ts">
  import type { CommitFileChange } from "../../types";
  import FileStatusBadge from "./FileStatusBadge.svelte";
  import { IconButton } from "$lib/components/ui";
  import * as m from "$lib/paraglide/messages";
  import { get, writable } from "svelte/store";
  import { remembered } from "$lib/stores/viewMemory";
  import { horizontalWheel } from "$lib/actions/horizontalWheel";
  import {
    computeVirtualWindow,
    findScroller,
    measureAgainstScroller,
    virtualRowStyle,
  } from "../../utils/virtualWindow";
  import {
    buildGenericChangesTree,
    flattenTree,
    type ChangesTreeRow,
  } from "../changes/changes-tree";

  let {
    files,
    onSelect,
    onContextMenu,
    memoryKey,
    treeToggle = false,
  }: {
    files: CommitFileChange[];
    onSelect?: (path: string) => void;
    onContextMenu?: (e: MouseEvent, path: string) => void;
    /**
     * When set, the selected path and the scroller offset outlive the
     * component under `<memoryKey>.selected` / `<memoryKey>.scrollTop`
     * (see `stores/viewMemory`). Callers scope it per repo and, where
     * the same pane shows different commits, per commit.
     */
    memoryKey?: string;
    /** When true, render a flat/tree toggle button in a slim header row. */
    treeToggle?: boolean;
  } = $props();

  // Without `memoryKey` these are plain per-instance writables, so the
  // component behaves exactly as before. `memoryKey` is read once at init
  // on purpose — a store cell is picked for the component's lifetime.
  // svelte-ignore state_referenced_locally
  const selectedPath = memoryKey
    ? remembered<string | null>(memoryKey + ".selected", null)
    : writable<string | null>(null);
  // svelte-ignore state_referenced_locally
  const savedScrollTop = memoryKey
    ? remembered(memoryKey + ".scrollTop", 0)
    : writable(0);

  // Reset selection when files change — but not on the first run, which
  // would wipe the remembered selection on remount.
  let firstFiles = true;
  $effect(() => {
    void files;
    if (firstFiles) {
      firstFiles = false;
      return;
    }
    $selectedPath = null;
  });

  // ── Flat / tree rows ──────────────────────────────────────────────────
  let treeMode = $state(false);
  let collapsedDirs = $state<Set<string>>(new Set());

  function toggleCollapse(path: string) {
    const next = new Set(collapsedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsedDirs = next;
  }

  type Row = ChangesTreeRow<CommitFileChange>;

  let treeRoots = $derived(buildGenericChangesTree(files));
  let rows: Row[] = $derived.by(() => {
    if (treeMode) return flattenTree(treeRoots, collapsedDirs);
    return files.map((f) => ({
      node: { kind: "file", path: f.path, name: f.path, payload: f },
      depth: 0,
    }));
  });

  function rowKey(row: Row): string {
    return (row.node.kind === "dir" ? "dir:" : "file:") + row.node.path;
  }

  // ── Virtualization ────────────────────────────────────────────────────
  // A commit's file list has no cap: an initial commit or a wide merge can
  // carry thousands of paths, and each row mounts a status badge.
  //
  // 26 px measured in the browser (`padding: 4px` plus content), uniform —
  // directory rows share the padding, so the window math holds in tree
  // mode too. The scroll container is the detail `<aside>`, not this list —
  // see `measureAgainstScroller`. Only engages above 500 rows, so every
  // existing baseline renders through the plain `{#each}`.
  const ROW_HEIGHT = 26;

  let listEl = $state<HTMLUListElement | null>(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  let virtualWindow = $derived(
    computeVirtualWindow({
      count: rows.length,
      rowHeight: ROW_HEIGHT,
      scrollTop,
      viewportHeight,
      threshold: 500,
    }),
  );

  // The remembered offset is the ancestor scroller's, restored once when the
  // list first has rows; `measure` then keeps the memory current.
  let scrollRestored = false;
  $effect(() => {
    // Re-runs when the row count changes (file list refresh, or a
    // collapse/expand in tree mode) — the list's offset within the scroller
    // depends on the content above it.
    void rows.length;
    if (!listEl) return;
    const scroller = findScroller(listEl);
    if (!scroller) return;

    if (!scrollRestored) {
      scrollRestored = true;
      const top = get(savedScrollTop);
      if (top > 0) scroller.scrollTop = top;
    }

    const measure = () => {
      if (!listEl) return;
      $savedScrollTop = scroller.scrollTop;
      ({ scrollTop, viewportHeight } = measureAgainstScroller(listEl, scroller));
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    return () => scroller.removeEventListener("scroll", measure);
  });

  /** Windowed rows are absolutely placed at their `index * ROW_HEIGHT`
   *  slot; every row is indented by its tree depth (depth 0 = the flat
   *  list's own 12px left padding).
   *
   *  Windowed rows ask for their own content width as well: the default
   *  `left: 0; right: 0` stretches them to the panel, which truncates a
   *  deep path into an ellipsis — the case `styles/tree-scroll.css`
   *  handles by scrolling the list sideways. Non-windowed rows get the
   *  same width from the `.tree-x-row` class on the `<li>`. */
  function rowStyle(index: number, depth: number, positioned: boolean): string {
    const indent = `padding-left: ${12 + depth * 14}px`;
    return positioned
      ? `${virtualRowStyle(index, ROW_HEIGHT, { intrinsicWidth: true })}; ${indent}`
      : indent;
  }

  function handleClick(path: string) {
    if (onSelect) {
      onSelect(path);
    }
    $selectedPath = $selectedPath === path ? null : path;
  }

  function splitPath(path: string): { dir: string; name: string } {
    const idx = path.lastIndexOf("/");
    if (idx === -1) return { dir: "", name: path };
    return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
  }
</script>

{#if treeToggle}
  <div class="list-toolbar">
    <IconButton
      tone="default"
      icon={treeMode ? "\uF0C9" : "\uF07B"}
      description={m.changes_tree_toggle()}
      testid="fcl-tree-toggle"
      onclick={() => { treeMode = !treeMode; }}
    />
  </div>
{/if}

{#if rows.length > 0}
  <ul class="file-list tree-x-scroll" use:horizontalWheel bind:this={listEl}>
    {#if virtualWindow}
      <!-- Windowed: the sizer holds the full scroll height, and only the
           visible slice is mounted, anchored at (index * ROW_HEIGHT). -->
      <li
        class="virt-sizer"
        style="height: {virtualWindow.totalHeight}px"
        aria-hidden="true"
      >
        {#each rows.slice(virtualWindow.start, virtualWindow.end) as row, offset (rowKey(row))}
          {@render rowView(row, virtualWindow.start + offset, true)}
        {/each}
      </li>
    {:else}
      {#each rows as row, i (rowKey(row))}
        {@render rowView(row, i, false)}
      {/each}
    {/if}
  </ul>
{/if}

{#snippet rowView(row: Row, index: number, positioned: boolean)}
  {@const node = row.node}
  <li class="tree-x-row" style={rowStyle(index, row.depth, positioned)}>
    {#if node.kind === "dir"}
      <button
        class="file-item dir-item"
        aria-label={m.changes_tree_toggle_folder({ path: node.path })}
        data-testid={"fcl-dir-" + node.path.replace(/\//g, '-')}
        onclick={() => toggleCollapse(node.path)}
      >
        <span class="chev" class:open={!collapsedDirs.has(node.path)}>{"\u25B6"}</span>
        <span class="file-path dir-name">{node.name}</span>
      </button>
    {:else}
      {@const parts = splitPath(node.path)}
      <button
        class="file-item"
        class:selected={$selectedPath === node.path}
        onclick={() => handleClick(node.path)}
        oncontextmenu={onContextMenu ? (e) => onContextMenu!(e, node.path) : undefined}
      >
        <FileStatusBadge status={node.payload.status} />
        <span class="file-path">
          {#if row.depth > 0}
            <span class="file-name">{node.name}</span>
          {:else}
            {#if parts.dir}<span class="file-dir">{parts.dir}</span>{/if}<span class="file-name">{parts.name}</span>
          {/if}
        </span>
      </button>
    {/if}
  </li>
{/snippet}

<style>
  .list-toolbar {
    display: flex;
    justify-content: flex-end;
    padding: 2px 4px 4px;
  }

  /* `tree-x-scroll` (styles/tree-scroll.css) makes this the sideways
     container for a deep path; the rows below it are the `tree-x-row`s.
     It stays an auto-height box, so `overflow-x: auto` — which computes
     `overflow-y` to `auto` as well — cannot start scrolling vertically
     and shadow the `<aside>` that actually does. */
  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* Sizer for the windowed path: carries the full scroll height while only
     the visible slice is mounted, absolutely positioned inside it. */
  .virt-sizer {
    position: relative;
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    min-width: 0;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    border-radius: 0;
    transition: background 0.1s;
  }

  .file-item:hover {
    background: color-mix(in srgb, var(--text-primary) 3%, transparent);
  }

  .file-item.selected {
    background: var(--overlay-accent-blue);
  }

  .file-path {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .file-dir {
    color: var(--text-secondary);
  }

  .file-name {
    color: var(--text-primary);
  }

  /* ── Tree-mode directory rows ──────────────────────────────────── */

  .dir-item {
    font-weight: 500;
  }

  .dir-item .chev {
    color: var(--text-secondary);
    transition: transform 0.12s ease;
    display: inline-block;
    /* Small arrowhead (▶ / ▼ via rotate): standard Unicode, not a Nerd
       Font private-use codepoint, so it never renders as tofu. */
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
  }

  .dir-item .chev.open {
    transform: rotate(90deg);
  }

  .dir-name {
    flex: 1;
  }
</style>
