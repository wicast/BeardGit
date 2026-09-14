<script lang="ts">
  import { onMount } from "svelte";
  import type { RecentRepo } from "$lib/types";
  import {
    getRecentRepos,
    removeRecentRepo,
    clearRecentRepos,
  } from "$lib/api/tauri";
  import { openProjectTab, openFolderAsProject, addMenuOpen } from "$lib/stores/projects";
  import { openCloneDialog } from "$lib/stores/cloneDialog";
  import { get } from "svelte/store";
  import ContextMenu from "$lib/components/common/ContextMenu.svelte";
  import type { MenuItem } from "$lib/components/common/ContextMenu.svelte";
  import * as m from "$lib/paraglide/messages";

  let recentRepos = $state<RecentRepo[]>([]);
  let menuRef = $state<HTMLDivElement | null>(null);

  let contextMenuVisible = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);
  let contextMenuItems = $state<MenuItem[]>([]);

  $effect(() => {
    if ($addMenuOpen) {
      loadRecent();
    } else {
      contextMenuVisible = false;
    }
  });

  async function loadRecent() {
    recentRepos = await getRecentRepos();
  }

  function handleOpenFolder() {
    addMenuOpen.set(false);
    openFolderAsProject();
  }

  function handleCloneProject() {
    addMenuOpen.set(false);
    openCloneDialog();
  }

  async function handleRecentClick(path: string) {
    addMenuOpen.set(false);
    await openProjectTab(path);
  }

  async function handleRemoveRecent(path: string) {
    try {
      await removeRecentRepo(path);
      await loadRecent();
    } catch (err) {
      console.error("Failed to remove recent repo:", err);
    }
  }

  async function handleClearAll() {
    try {
      await clearRecentRepos();
      recentRepos = [];
    } catch (err) {
      console.error("Failed to clear recent repos:", err);
    }
  }

  function handleRecentContextMenu(e: MouseEvent, repo: RecentRepo) {
    e.preventDefault();
    e.stopPropagation();
    contextMenuItems = [
      {
        label: m.tab_add_open_recent(),
        action: () => void handleRecentClick(repo.path),
      },
      { separator: true },
      {
        label: m.tab_add_remove_recent(),
        tone: "danger",
        action: () => void handleRemoveRecent(repo.path),
      },
      {
        label: m.tab_add_clear_recent(),
        tone: "danger",
        action: () => void handleClearAll(),
      },
    ];
    contextMenuX = e.clientX;
    contextMenuY = e.clientY;
    contextMenuVisible = true;
  }

  function closeAddMenu() {
    contextMenuVisible = false;
    addMenuOpen.set(false);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      closeAddMenu();
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (!get(addMenuOpen)) return;
    // Ignore clicks on the + button itself (it toggles via its own handler),
    // inside the dropdown, and on the context-menu layer so its item actions
    // (and backdrop dismiss) can run without tearing the add menu down first.
    const target = e.target as HTMLElement;
    if (
      target.closest(".add-button-wrapper") ||
      target.closest(".add-menu") ||
      target.closest(".context-menu") ||
      target.closest(".backdrop")
    ) {
      return;
    }
    closeAddMenu();
  }

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

{#if $addMenuOpen}
  <div class="add-menu" bind:this={menuRef}>
    <button class="menu-item" onclick={handleOpenFolder}>
      <span class="menu-icon">{"\uF07C"}</span>
      <span>{m.tab_add_open_folder()}</span>
    </button>

    <button class="menu-item" onclick={handleCloneProject}>
      <span class="menu-icon">{"\uF019"}</span>
      <span>{m.tab_add_clone_project()}</span>
    </button>

    <div class="menu-divider"></div>

    <div class="menu-section-label-row">
      <div class="menu-section-label">{m.tab_add_recent()}</div>
      {#if recentRepos.length > 0}
        <button
          class="section-clear"
          onclick={() => void handleClearAll()}
          title={m.tab_add_clear_recent()}
        >
          {m.tab_add_clear_recent()}
        </button>
      {/if}
    </div>

    {#if recentRepos.length === 0}
      <div class="menu-empty">{m.tab_add_no_recent()}</div>
    {:else}
      {#each recentRepos as repo (repo.path)}
        <button
          class="menu-item"
          onclick={() => handleRecentClick(repo.path)}
          oncontextmenu={(e) => handleRecentContextMenu(e, repo)}
          title={repo.path}
        >
          <span class="menu-icon">{"\uF07C"}</span>
          <span>{repo.name}</span>
        </button>
      {/each}
    {/if}
  </div>
{/if}

<ContextMenu
  items={contextMenuItems}
  x={contextMenuX}
  y={contextMenuY}
  visible={contextMenuVisible}
  onClose={() => (contextMenuVisible = false)}
/>

<style>
  .add-menu {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 100;
    min-width: 200px;
    max-width: 320px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow-overlay);
    padding: 4px 0;
    margin-top: 2px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 6px 12px;
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-item:hover {
    background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  }

  .menu-icon {
    font-family: var(--font-icons);
    font-size: var(--font-size-lg);
    width: 16px;
    text-align: center;
    flex-shrink: 0;
    color: var(--accent-primary);
  }

  .menu-divider {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
  }

  .menu-section-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 12px 2px;
  }

  .menu-section-label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .section-clear {
    background: none;
    border: none;
    padding: 0;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .section-clear:hover {
    color: var(--accent-red);
  }

  .menu-empty {
    padding: 6px 12px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    font-style: italic;
  }
</style>
