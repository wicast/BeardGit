<script lang="ts">
  import * as m from "$lib/paraglide/messages";
  import {
    filteredTags,
    selectedTagName,
    tagsLoading,
    hasMoreTags,
    tagFilter,
    tags,
    selectTag,
    loadMoreTags,
    refreshTags,
    searchTagsBackend,
    restorePreFilterTags,
    doDeleteTag,
    doPushTag,
  } from "../../stores/tags";
  import { remotes } from "../../stores/remotes";
  import { tagPushRemote } from "../../stores/tagPushRemote";
  import TagCreateDialog from "./TagCreateDialog.svelte";
  import TagPushRemoteSelect from "./TagPushRemoteSelect.svelte";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import ContextMenu from "../common/ContextMenu.svelte";
  import List from "../common/List.svelte";
  import { Button, IconButton } from "$lib/components/ui";
  import { formatRelativeTime } from "../../utils/time";
  import { debounce } from "../../utils/debounce";
  import type { MenuItem } from "../common/ContextMenu.svelte";
  import type { TagInfo } from "../../types";
  import { scoped } from "$lib/stores/viewMemory";
  import { navigateToCommit } from "../../stores/graph";
  import { activeViewStore } from "../../stores/navigation";

  let loadingMore = $state(false);
  let showCreateDialog = $state(false);
  let confirmDelete = $state<string | null>(null);
  // Seeded from the store: the filter outlives this component, and an
  // empty input over a filtered list read as the app losing the filter.
  let filterValue = $state($tagFilter);
  let searchingBackend = $state(false);

  // ── Row context menu ─────────────────────────────────────────────────
  let menuVisible = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  /** The tag the menu was opened on; `null` while the menu is closed. */
  let contextTag = $state<TagInfo | null>(null);

  const debouncedBackendSearch = debounce(async (value: string) => {
    if (value.length >= 2 && $filteredTags.length === 0) {
      searchingBackend = true;
      await searchTagsBackend(value);
      searchingBackend = false;
    }
  }, 300);

  function handleFilterInput() {
    if (!filterValue) {
      tagFilter.set("");
      restorePreFilterTags();
      searchingBackend = false;
      return;
    }

    tagFilter.set(filterValue);
    debouncedBackendSearch(filterValue);
  }

  async function handleLoadMore() {
    loadingMore = true;
    try {
      await loadMoreTags();
    } finally {
      loadingMore = false;
    }
  }

  function handleRefresh() {
    filterValue = "";
    tagFilter.set("");
    refreshTags();
  }

  function getKey(tag: TagInfo): string {
    return tag.name;
  }

  function handleSelect(tag: TagInfo) {
    selectTag(tag.name);
  }

  /**
   * Push one tag. `remote` is explicit because the context menu can target
   * any remote; the row's hover button and the footers use the shared
   * default from `stores/tagPushRemote`.
   *
   * No success toast here (nor in `doPushTag`): the push runs as a
   * `GitPush` task, so the drawer row reaching a terminal state is the
   * confirmation.
   */
  async function pushTag(name: string | null, remote: string) {
    try {
      await doPushTag(name, remote);
    } catch {
      // runMutation already surfaced the failure toast.
    }
  }

  function handleContextMenu(e: MouseEvent, tag: TagInfo) {
    contextTag = tag;
    menuX = e.clientX;
    menuY = e.clientY;
    menuVisible = true;
  }

  /**
   * "Push" menu item. One remote fires directly; several open a submenu, so
   * the target is always named before the click — mirroring `BranchList`.
   */
  function pushMenuItem(tag: TagInfo): MenuItem {
    const rs = $remotes;
    if (rs.length === 1) {
      const remote = rs[0].name;
      return {
        label: m.tags_push_to_remote({ remote }),
        action: () => pushTag(tag.name, remote),
      };
    }
    return {
      label: m.tags_action_push(),
      children: rs.map((remote) => ({
        label: remote.name,
        action: () => pushTag(tag.name, remote.name),
      })),
    };
  }

  function showCommitInGraph(oid: string) {
    void navigateToCommit(oid);
    // Selects the commit in the graph store; without the view switch the
    // selection changes behind a Tags view that never visibly moves.
    activeViewStore.set("graph");
  }

  let menuItems = $derived.by((): MenuItem[] => {
    const tag = contextTag;
    if (!tag) return [];
    const items: MenuItem[] = [];
    if ($remotes.length > 0) {
      items.push(pushMenuItem(tag), { separator: true });
    }
    items.push(
      {
        label: m.tags_menu_copy_name(),
        action: () => void navigator.clipboard?.writeText(tag.name),
      },
      {
        label: m.tags_menu_copy_sha({ sha: tag.commit_oid.slice(0, 8) }),
        action: () => void navigator.clipboard?.writeText(tag.commit_oid),
      },
      {
        label: m.tags_menu_show_in_graph(),
        action: () => showCommitInGraph(tag.commit_oid),
      },
      { separator: true },
      {
        label: m.tags_action_delete(),
        tone: "danger",
        action: () => (confirmDelete = tag.name),
      },
    );
    return items;
  });
</script>

<List
  items={$filteredTags}
  loading={$tagsLoading}
  title={m.tags_title()}
  selectedKey={$selectedTagName}
  {getKey}
  emptyMessage={m.tags_empty()}
  onSelect={handleSelect}
  onContextMenu={handleContextMenu}
  memoryKey={scoped("tags.list")}
>
  {#snippet headerActions()}
    <Button variant="primary" size="sm" onclick={() => (showCreateDialog = true)}>
      {m.tags_create_button()}
    </Button>
    <IconButton
      icon={"\uF021"}
      description={m.tooltip_refresh()}
      loading={$tagsLoading}
      onclick={handleRefresh}
    />
  {/snippet}

  {#snippet afterHeader()}
    <div class="filter-row">
      <input
        type="text"
        class="filter-input"
        placeholder={m.tags_filter_placeholder()}
        bind:value={filterValue}
        oninput={handleFilterInput}
      />
    </div>
  {/snippet}

  {#snippet emptyState()}
    {#if searchingBackend}
      <div class="list-loading">
        <div class="spinner"></div>
        <span>{m.tags_no_results_searching()}</span>
      </div>
    {:else}
      <div class="list-empty">{m.tags_empty()}</div>
    {/if}
  {/snippet}

  {#snippet row({ item })}
    <div class="tag-content">
      <div class="tag-top">
        <span class="tag-name">{item.name}</span>
        <span class="tag-time">
          {item.date ? formatRelativeTime(item.date) : ""}
        </span>
      </div>
      <div class="tag-bottom-container">
        <div class="tag-bottom">
          {#if item.annotated}
            <span class="tag-badge-annotated">{m.tags_badge_annotated()}</span>
          {/if}
          <span class="tag-oid">{item.commit_oid.slice(0, 8)}</span>
        </div>
        <div class="tag-bottom-hover">
          <div class="tag-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={$tagPushRemote === null}
              description={$tagPushRemote === null
                ? m.tags_push_no_remote()
                : m.tags_push_to_remote({ remote: $tagPushRemote })}
              onclick={(e: MouseEvent) => {
                e.stopPropagation();
                if ($tagPushRemote) pushTag(item.name, $tagPushRemote);
              }}
            >{m.tags_action_push()}</Button>
            <Button
              variant="danger"
              size="sm"
              onclick={(e: MouseEvent) => { e.stopPropagation(); confirmDelete = item.name; }}
            >{m.tags_action_delete()}</Button>
          </div>
          <span class="tag-oid">{item.commit_oid.slice(0, 8)}</span>
        </div>
      </div>
    </div>
  {/snippet}

  {#snippet footer()}
    <div class="tags-footer">
      {#if $hasMoreTags && !filterValue}
        <Button variant="neutral" size="sm" onclick={handleLoadMore} disabled={loadingMore} loading={loadingMore}>
          {#if !loadingMore}{m.tags_load_more({ count: String($tags.length) })}{/if}
        </Button>
      {/if}

      <div class="push-all">
        <Button
          variant="primary"
          size="sm"
          disabled={$tagPushRemote === null}
          description={$tagPushRemote === null
            ? m.tags_push_no_remote()
            : m.tags_push_to_remote({ remote: $tagPushRemote })}
          onclick={() => { if ($tagPushRemote) pushTag(null, $tagPushRemote); }}
        >
          {m.tags_push_all_button()}
        </Button>
        <!-- Shares its selection with the tag detail footer — see
             `stores/tagPushRemote`. -->
        <TagPushRemoteSelect testid="tag-push-all-remote" />
      </div>
    </div>
  {/snippet}
</List>

<ContextMenu
  items={menuItems}
  x={menuX}
  y={menuY}
  visible={menuVisible}
  onClose={() => (menuVisible = false)}
/>

{#if showCreateDialog}
  <TagCreateDialog onClose={() => (showCreateDialog = false)} />
{/if}

{#if confirmDelete !== null}
  {@const deleteTag = $filteredTags.find((t) => t.name === confirmDelete)}
  <ConfirmDialog
    title={m.tags_delete_dialog_title()}
    detail={deleteTag ? `${deleteTag.name}\n${deleteTag.commit_oid.slice(0, 8)}` : confirmDelete}
    message={m.tags_delete_body({ name: confirmDelete })}
    confirmLabel={m.tags_delete_confirm()}
    destructive={true}
    onConfirm={() => {
      doDeleteTag(confirmDelete!);
      confirmDelete = null;
    }}
    onCancel={() => (confirmDelete = null)}
  />
{/if}

<style>
  .tag-content {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
  }

  .tag-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .tag-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .tag-time {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .tag-bottom-container {
    display: grid;
  }

  .tag-bottom,
  .tag-bottom-hover {
    grid-area: 1 / 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .tag-bottom-hover {
    visibility: hidden;
  }

  :global(.list-row:hover) .tag-bottom {
    visibility: hidden;
  }

  :global(.list-row:hover) .tag-bottom-hover {
    visibility: visible;
  }

  .tag-actions {
    display: flex;
    gap: 4px;
    align-items: center;
  }

.tag-badge-annotated {
    font-size: 9px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent-orange) 15%, transparent);
    color: var(--accent-orange);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .tag-oid {
    font-size: var(--font-size-2xs);
    font-family: var(--font-mono);
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .tags-footer {
    display: flex;
    justify-content: center;
    /* Wraps rather than squeezing: the footer is two controls per row now
       (push-all + its remote picker, plus "load more"), and a narrow list
       pane would otherwise clip the picker. */
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px;
    border-top: 1px solid var(--border);
  }

  /* The button and its remote picker are one control group. */
  .push-all {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
</style>
