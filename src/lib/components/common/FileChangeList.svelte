<!--
  FileChangeList — Selectable file list with status icons and path highlighting.

  Shared component used by tag detail, graph commit detail, stash detail,
  and branch commit detail. Displays repo-relative paths with directory
  portions dimmed and the filename highlighted. Emits `onSelect` when a
  file is clicked.

  Tree mode (opt-in via `treeToggle`): groups the flat list into collapsible
  directory rows rendered with the same tree model as the Changes view
  (`buildGenericChangesTree` + `flattenTree`). The flat/tree preference and
  collapsed-dir set are component-local — read-only commit file lists are
  not tied to the global working-tree `changesTreeView` preference. When
  `treeToggle` is absent (false) the component renders exactly as before.
-->
<script lang="ts">
  import type { CommitFileChange } from "../../types";
  import FileStatusBadge from "./FileStatusBadge.svelte";
  import { IconButton } from "$lib/components/ui";
  import * as m from "$lib/paraglide/messages";
  import {
    buildGenericChangesTree,
    flattenTree,
    type ChangesTreeNode,
  } from "../changes/changes-tree";

  let {
    files,
    onSelect,
    onContextMenu,
    /** When true, render a flat/tree toggle button in a slim header row. */
    treeToggle = false,
  }: {
    files: CommitFileChange[];
    onSelect?: (path: string) => void;
    onContextMenu?: (e: MouseEvent, path: string) => void;
    treeToggle?: boolean;
  } = $props();

  let selectedPath = $state<string | null>(null);
  let treeMode = $state(false);
  let collapsedDirs = $state<Set<string>>(new Set());

  // Reset selection when files change
  $effect(() => {
    if (files) {
      selectedPath = null;
    }
  });

  /** Tree rows for the current mode — empty in flat mode. */
  let treeRoots = $derived(buildGenericChangesTree(files));
  let treeRows = $derived(
    treeMode ? flattenTree(treeRoots, collapsedDirs) : [],
  );

  function handleClick(path: string) {
    if (onSelect) {
      onSelect(path);
    }
    selectedPath = selectedPath === path ? null : path;
  }

  function toggleCollapse(path: string) {
    const next = new Set(collapsedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsedDirs = next;
  }

  function splitPath(path: string): { dir: string; name: string } {
    const idx = path.lastIndexOf("/");
    if (idx === -1) return { dir: "", name: path };
    return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
  }

  /** Row padding for tree rows; flat rows keep the legacy 12px. */
  function rowPad(depth: number): string {
    return depth > 0 ? `12px 12px 12px ${12 + depth * 14}px` : "4px 12px";
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

{#if treeMode && treeRows.length > 0}
  <ul class="file-list">
    {#each treeRows as row ((row.node.kind === "dir" ? "dir:" : "file:") + row.node.path)}
      {@const node = row.node}
      {#if node.kind === "dir"}
        <li>
          <button
            class="file-item dir-item"
            style="padding-left: {12 + row.depth * 14}px"
            aria-label={m.changes_tree_toggle_folder({ path: node.path })}
            data-testid={"fcl-dir-" + node.path.replace(/\//g, '-')}
            onclick={() => toggleCollapse(node.path)}
          >
            <span class="chev" class:open={!collapsedDirs.has(node.path)}>{"\u25B6"}</span>
            <span class="file-path dir-name">{node.name}</span>
          </button>
        </li>
      {:else}
        <li>
          <button
            class="file-item"
            class:selected={selectedPath === node.path}
            style="padding-left: {12 + row.depth * 14}px"
            onclick={() => handleClick(node.path)}
            oncontextmenu={onContextMenu ? (e) => onContextMenu!(e, node.path) : undefined}
          >
            <FileStatusBadge status={node.payload.status} />
            <span class="file-path">{node.name}</span>
          </button>
        </li>
      {/if}
    {/each}
  </ul>
{:else if files.length > 0}
  <ul class="file-list">
    {#each files as file (file.path)}
      {@const parts = splitPath(file.path)}
      <li>
        <button
          class="file-item"
          class:selected={selectedPath === file.path}
          onclick={() => handleClick(file.path)}
          oncontextmenu={onContextMenu ? (e) => onContextMenu!(e, file.path) : undefined}
        >
          <FileStatusBadge status={file.status} />
          <span class="file-path">
            {#if parts.dir}<span class="file-dir">{parts.dir}</span>{/if}<span class="file-name">{parts.name}</span>
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .list-toolbar {
    display: flex;
    justify-content: flex-end;
    padding: 2px 4px 4px;
  }

  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    min-width: 0;
    width: 100%;
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
