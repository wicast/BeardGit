<script lang="ts">
  import { onMount } from "svelte";
  import { fileStatuses } from "../../stores/changes";
  import { hasActiveProvider, activeProvider } from "../../stores/provider";
  import { sidebarLayout, updateLayout } from "../../stores/sidebarLayout";
  import { aiSurfacesVisible } from "../../stores/ai";
  import { type SidebarNavItem } from "../../utils/applyLayout";
  import { addToast } from "../../stores/toast";
  import { IconButton } from "$lib/components/ui";
  import ResizeHandle from "../common/ResizeHandle.svelte";
  import { remembered } from "../../stores/viewMemory";
  import * as m from "$lib/paraglide/messages";

  let {
    onNavigate,
    activeView = "graph",
    collapsed = false,
    onToggleCollapse,
  }: {
    onNavigate?: (view: string) => void;
    activeView?: string;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
  } = $props();

  /** All registered Navigation items. */
  const navItems: SidebarNavItem[] = [
    { label: m.sidebar_graph(), icon: "", id: "graph" },
    { label: m.sidebar_changes(), icon: "", id: "changes" },
    { label: m.sidebar_editor(), icon: "", id: "editor" },
    { label: m.sidebar_branches(), icon: "", id: "branches" },
    { label: m.sidebar_tags(), icon: "", id: "tags" },
    { label: m.sidebar_stashes(), icon: "", id: "stashes" },
    { label: m.sidebar_worktrees(), icon: "", id: "worktrees" },
    { label: m.sidebar_reflog(), icon: "", id: "reflog" },
    { label: m.sidebar_bisect(), icon: "", id: "bisect" },
    { label: m.sidebar_submodules(), icon: "", id: "submodules" },
    { label: m.sidebar_ai_config(), icon: "", id: "ai-config" },
    { label: m.sidebar_ai_sessions(), icon: "", id: "ai-sessions" },
    { label: m.sidebar_requests(), icon: "", id: "requests" },
  ];

  // Edit-mode state.
  let editMode = $state(false);
  let sidebarEl: HTMLElement | undefined = $state();

  /**
   * Navigation width, drag-resizable since the labels are the first thing
   * that stops fitting at 15vw on a narrow window.
   *
   * `null` until the user drags: the width stays the responsive
   * `clamp()` it has always been, so a pane nobody has resized keeps
   * behaving like a fluid layout instead of freezing into the px value it
   * happened to render at on mount. `remembered` (RAM-only session memory,
   * like every other split in the app) carries the dragged value across
   * view switches; collapsing is unaffected — it still pins 44px.
   */
  const NAV_DEFAULT_WIDTH = "clamp(180px, 15vw, 240px)";
  const navWidth = remembered<number | null>("layout.navSidebarWidth", null);
  let navPaneX = $derived($navWidth === null ? NAV_DEFAULT_WIDTH : `${$navWidth}px`);

  /**
   * True for the duration of a collapse/expand, which is the *only* width
   * change that animates.
   *
   * The `transition: width 150ms` this gates was written for that toggle and
   * then quietly applied to everything: a drag ran the pane 150ms behind the
   * cursor (until the drag state suppressed it), an arrow-key nudge settled
   * visibly late, and — the one that actually breaks — a reset followed by a
   * fresh grab measured the pane mid-animation and started the new drag from
   * a width it was never at. Scoping the transition to the toggle keeps the
   * animation where it was wanted and makes every user-driven width change
   * land on the frame it was asked for.
   */
  let animatingCollapse = $state(false);
  // svelte-ignore state_referenced_locally
  // Seeded with the current value on purpose: this only ever holds the
  // *previous* `collapsed`, to tell a toggle apart from a re-render.
  let wasCollapsed = collapsed;
  $effect(() => {
    if (wasCollapsed === collapsed) return;
    wasCollapsed = collapsed;
    animatingCollapse = true;
    const timer = setTimeout(() => (animatingCollapse = false), 200);
    return () => clearTimeout(timer);
  });

  /** Half the window at most: the nav may never crowd out the view it navigates. */
  function navMaxWidth(): number {
    return Math.min(480, Math.round(window.innerWidth * 0.5));
  }

  const itemById = new Map(navItems.map((i) => [i.id, i]));

  /**
   * Fixed task groups. Items are grouped by job rather than presented as
   * one 13-item wall. The order is intentionally not user-customisable —
   * customisation is hiding items (and whole groups collapse away when all
   * their items are hidden), which keeps the grouping meaningful.
   *
   * The forge group (Pipelines/Issues/PRs/Releases) is rendered separately
   * below from `providerItems` since it only exists when a provider is
   * connected.
   */
  interface NavGroup {
    key: string;
    label: string;
    ids: readonly string[];
  }
  const navGroups: NavGroup[] = [
    { key: "workspace", label: m.sidebar_group_workspace(), ids: ["graph", "changes", "editor", "requests"] },
    { key: "history", label: m.sidebar_group_history(), ids: ["branches", "tags", "stashes", "reflog"] },
    { key: "advanced", label: m.sidebar_group_advanced(), ids: ["worktrees", "submodules", "bisect"] },
    { key: "ai", label: m.sidebar_group_ai(), ids: ["ai-config", "ai-sessions"] },
  ];

  function groupItems(ids: readonly string[]): SidebarNavItem[] {
    return ids.map((id) => itemById.get(id)).filter((x): x is SidebarNavItem => !!x);
  }

  /** Normal-mode groups: only visible items, and groups with none drop out.
   *  The whole AI group additionally drops out when the AI master switch
   *  (Settings → AI) is off — hiding it via the persisted `hidden` set
   *  would fight the user's manual layout customisation. */
  let visibleGroups = $derived.by(() => {
    const hiddenSet = new Set($sidebarLayout.hidden);
    return navGroups
      .filter((g) => g.key !== "ai" || $aiSurfacesVisible)
      .map((g) => ({ ...g, items: groupItems(g.ids).filter((i) => !hiddenSet.has(i.id)) }))
      .filter((g) => g.items.length > 0);
  });

  /** Flat visible list for collapsed mode (icons only, no group headers). */
  let visibleFlat = $derived(visibleGroups.flatMap((g) => g.items));

  /** Edit-mode groups: every item, hidden ones included (greyed). AI
   *  entries hide here too when the subsystem is disabled — there's
   *  nothing to customise about a switched-off feature. */
  let editGroups = $derived(
    navGroups
      .filter((g) => g.key !== "ai" || $aiSurfacesVisible)
      .map((g) => ({ ...g, items: groupItems(g.ids) })),
  );

  /** Force-exit edit mode if the sidebar collapses. */
  $effect(() => {
    if (collapsed && editMode) editMode = false;
  });

  /** Escape + outside-click handlers while in edit mode. */
  $effect(() => {
    if (!editMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") editMode = false;
    }
    function onPointer(e: MouseEvent) {
      if (!sidebarEl) return;
      if (!sidebarEl.contains(e.target as Node)) editMode = false;
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  });

  // MR/PR label depends on the active forge.
  let providerItems = $derived.by<SidebarNavItem[]>(() => {
    const base: SidebarNavItem[] = [
      { label: m.sidebar_pipelines(), icon: "", id: "pipelines" },
      { label: m.sidebar_issues(), icon: "", id: "issues" },
      {
        label:
          $activeProvider?.kind === "github"
            ? m.sidebar_pull_requests()
            : m.sidebar_merge_requests(),
        icon: "",
        id: "merge-requests",
      },
      { label: m.sidebar_releases(), icon: "", id: "releases" },
    ];
    const kind = $activeProvider?.kind;
    if (kind === "github" || kind === "gitlab") {
      base.push({
        label: m.sidebar_repo_config(),
        icon: "",
        id: "repo-config",
      });
    }
    return base;
  });

  function handleNav(id: string) {
    if (editMode) return; // Clicks on the row are reorder/toggle targets,
                          // not navigation, while editing.
    onNavigate?.(id);
  }

  /** Toggle an id between visible and hidden, guarding "at least one visible". */
  function toggleHidden(id: string) {
    const hidden = new Set($sidebarLayout.hidden);
    if (hidden.has(id)) {
      hidden.delete(id);
      updateLayout({ hidden: [...hidden] });
      return;
    }
    // About to hide → ensure at least one other item remains visible.
    const nextHidden = new Set(hidden);
    nextHidden.add(id);
    const remainingVisible = navItems.filter((i) => !nextHidden.has(i.id));
    if (remainingVisible.length === 0) {
      addToast({ message: m.sidebar_min_visible(), type: "warning" });
      return;
    }
    updateLayout({ hidden: [...nextHidden] });
  }

  /** Reset customisation: groups are fixed, so this just unhides everything. */
  function resetLayout() {
    updateLayout({ hidden: [] });
  }

  let changeCount = $derived($fileStatuses.length);

  // ─── Collapsed-mode tooltip ─────────────────────────────────────────
  // The shared `ui/Tooltip.svelte` only places top/bottom and positions
  // itself absolutely *inside* the trigger — the sidebar's
  // `overflow-y: auto` scroll container would clip a right-side popover.
  // Instead we render one fixed-position tooltip at the hovered item's
  // right edge, which escapes the scroll clipping entirely. Same visual
  // language as the Tooltip primitive (tokens + --shadow-overlay).
  let collapsedTip = $state<{ text: string; top: number; left: number } | null>(null);
  let tipTimer: ReturnType<typeof setTimeout> | undefined;

  function showTip(e: MouseEvent | FocusEvent, label: string) {
    if (!collapsed) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      collapsedTip = {
        text: label,
        top: rect.top + rect.height / 2,
        left: rect.right + 8,
      };
    }, 250);
  }

  function hideTip() {
    clearTimeout(tipTimer);
    collapsedTip = null;
  }

  /** Clear any pending tooltip when the component unmounts. */
  $effect(() => () => clearTimeout(tipTimer));

  /** Tooltips make no sense once expanded — drop any in-flight one. */
  $effect(() => {
    if (!collapsed) hideTip();
  });
</script>

<!-- The shell exists only to anchor the resize handle: the handle has to sit
     outside `<aside>`'s `overflow-y: auto` scroll container, or it would
     scroll away with the nav list instead of staying on the seam. -->
<div class="sidebar-shell" style:--pane-x={navPaneX}>
  <aside
    class="sidebar"
    class:collapsed
    class:animating={animatingCollapse}
    class:edit-mode={editMode}
    bind:this={sidebarEl}
  >
    <nav class="nav-section">
      {#if !collapsed}
        <div class="section-label nav-header">
          <span>{m.sidebar_navigation()}</span>
          {#if editMode}
            <span class="edit-actions">
              <button
                type="button"
                class="edit-action"
                data-testid="sidebar-edit-reset"
                onclick={resetLayout}
              >{m.sidebar_reset()}</button>
              <button
                type="button"
                class="edit-action primary"
                data-testid="sidebar-edit-done"
                onclick={() => (editMode = false)}
              >{m.sidebar_done()}</button>
            </span>
          {:else}
            <IconButton
              icon={"\uF040"}
              description={m.tooltip_customize_sidebar()}
              size="sm"
              testid="sidebar-edit-toggle"
              onclick={() => (editMode = true)}
            />
          {/if}
        </div>
      {/if}

      {#if editMode}
        <div class="sr-only" role="status" aria-live="polite">
          {m.sidebar_customize()}. Press Escape to finish.
        </div>
        {#each editGroups as group (group.key)}
          <div class="group-label">{group.label}</div>
          {#each group.items as item (item.id)}
            {@const isHidden = $sidebarLayout.hidden.includes(item.id)}
            {@const visibleCount = navItems.length - $sidebarLayout.hidden.length}
            {@const isLastVisible = !isHidden && visibleCount <= 1}
            <div
              class="nav-item edit-row"
              class:nav-item--hidden={isHidden}
              data-testid="nav-{item.id}"
            >
              <span class="nav-icon">{item.icon}</span>
              <span class="nav-label">{item.label}</span>
              <button
                type="button"
                class="eye-toggle"
                data-testid="sidebar-hide-{item.id}"
                aria-pressed={!isHidden}
                aria-disabled={isLastVisible}
                disabled={isLastVisible}
                aria-label={isHidden
                  ? m.sidebar_show_aria({ label: item.label })
                  : m.sidebar_hide_aria({ label: item.label })}
                onclick={() => toggleHidden(item.id)}
              >{isHidden ? "" : ""}</button>
            </div>
          {/each}
        {/each}
      {:else if collapsed}
        {#each visibleFlat as item (item.id)}
          <button
            class="nav-item"
            class:active={activeView === item.id}
            onclick={() => { hideTip(); handleNav(item.id); }}
            onmouseenter={(e) => showTip(e, item.label)}
            onmouseleave={hideTip}
            onfocusin={(e) => showTip(e, item.label)}
            onfocusout={hideTip}
            aria-label={item.label}
            data-testid="nav-{item.id}"
          >
            <span class="nav-icon">{item.icon}</span>
          </button>
        {/each}
      {:else}
        {#each visibleGroups as group (group.key)}
          <div class="group-label">{group.label}</div>
          {#each group.items as item (item.id)}
            <button
              class="nav-item"
              class:active={activeView === item.id}
              onclick={() => { hideTip(); handleNav(item.id); }}
              data-testid="nav-{item.id}"
            >
              <span class="nav-icon">{item.icon}</span>
              <span class="nav-label">{item.label}</span>
              {#if item.id === "changes" && changeCount > 0}
                <span class="nav-badge">{changeCount}</span>
              {/if}
            </button>
          {/each}
        {/each}
      {/if}
    </nav>

    {#if $hasActiveProvider}
      <nav class="nav-section">
        {#if !collapsed}
          <div class="section-label">
            <span class="provider-status-dot connected"></span>
            {$activeProvider?.kind === 'github' ? m.provider_github() : m.provider_gitlab()}
          </div>
        {/if}
        {#each providerItems as item}
          <button
            class="nav-item"
            class:active={activeView === item.id}
            onclick={() => { hideTip(); handleNav(item.id); }}
            onmouseenter={(e) => showTip(e, item.label)}
            onmouseleave={hideTip}
            onfocusin={(e) => showTip(e, item.label)}
            onfocusout={hideTip}
            aria-label={collapsed ? item.label : undefined}
            data-testid="nav-{item.id}"
          >
            <span class="nav-icon">{item.icon}</span>
            {#if !collapsed}
              <span class="nav-label">{item.label}</span>
            {/if}
          </button>
        {/each}
      </nav>
    {/if}

    <div class="spacer"></div>

    <div class="nav-section bottom-section">
      <button
        class="nav-item"
        class:active={activeView === "settings"}
        onclick={() => { hideTip(); handleNav("settings"); }}
        onmouseenter={(e) => showTip(e, m.sidebar_settings())}
        onmouseleave={hideTip}
        onfocusin={(e) => showTip(e, m.sidebar_settings())}
        onfocusout={hideTip}
        aria-label={collapsed ? m.sidebar_settings() : undefined}
        data-testid="nav-settings"
      >
        <span class="nav-icon">{""}</span>
        {#if !collapsed}
          <span class="nav-label">{m.sidebar_settings()}</span>
        {/if}
      </button>
      <button
        class="nav-item collapse-btn"
        onclick={() => { hideTip(); onToggleCollapse?.(); }}
        onmouseenter={(e) => showTip(e, m.sidebar_expand())}
        onmouseleave={hideTip}
        onfocusin={(e) => showTip(e, m.sidebar_expand())}
        onfocusout={hideTip}
        aria-label={collapsed ? m.sidebar_expand() : undefined}
      >
        <span class="nav-icon">{collapsed ? "" : ""}</span>
        {#if !collapsed}
          <span class="nav-label">{m.sidebar_collapse()}</span>
        {/if}
      </button>
    </div>
  </aside>

  <!-- No handle while collapsed: the width is pinned at 44px, so a drag
       would have nowhere to go and the grab strip would sit on top of the
       icon rail. -->
  {#if !collapsed}
    <ResizeHandle
      size={$navWidth}
      onSizeChange={(next) => navWidth.set(next)}
      min={160}
      max={navMaxWidth}
      label={m.resize_nav_sidebar()}
      testid="nav-resize-handle"
    />
  {/if}
</div>

{#if collapsedTip}
  <span
    class="collapsed-tooltip"
    role="tooltip"
    style="top: {collapsedTip.top}px; left: {collapsedTip.left}px"
  >{collapsedTip.text}</span>
{/if}

<style>
  /* Anchors the resize handle, which is positioned over the seam rather
     than laid out in it (see `lib/styles/resize-handle.css`). */
  .sidebar-shell {
    position: relative;
    display: flex;
    flex-shrink: 0;
  }

  .sidebar {
    /* `--pane-x` is the one place this width lives: the handle reads it to
       find the seam, and the shell's inline style overrides it once the
       user has dragged. */
    width: var(--pane-x, clamp(180px, 15vw, 240px));
    min-width: 0;
    flex-shrink: 0;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    user-select: none;
  }

  /* Collapse/expand animates; every user-driven width change is instant —
     see `animatingCollapse`. */
  .sidebar.animating {
    transition: width 150ms ease;
  }

  .sidebar.collapsed {
    width: 44px;
  }

  .nav-section {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }

  .nav-section:last-child {
    border-bottom: none;
  }

  .bottom-section {
    border-top: 1px solid var(--border);
    border-bottom: none;
  }

  .section-label {
    padding: 4px 16px 6px;
    font-size: var(--font-size-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    overflow: hidden;
    white-space: nowrap;
  }

  .nav-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  /* Task-group sub-header (Workspace / History / Advanced / AI). Dimmer
     and tighter than the top section label so it reads as a grouping, and
     the first group sits flush under the Navigation header. */
  .group-label {
    padding: 10px 16px 4px;
    font-size: var(--font-size-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    overflow: hidden;
    white-space: nowrap;
  }

  .nav-section > .group-label:first-of-type {
    padding-top: 2px;
  }

  .edit-actions {
    display: inline-flex;
    gap: 6px;
  }

  .edit-action {
    background: none;
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
    text-transform: none;
    letter-spacing: 0;
  }

  .edit-action:hover {
    background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  }

  .edit-action.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 16px;
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: var(--font-size-md);
    cursor: pointer;
    text-align: left;
    transition: background 0.15s;
    overflow: hidden;
    white-space: nowrap;
  }

  .sidebar.collapsed .nav-item {
    justify-content: center;
    padding: 6px 0;
  }

  .nav-item:hover {
    background: color-mix(in srgb, var(--text-primary) 5%, transparent);
  }

  .sidebar:not(.edit-mode) .nav-item.active {
    background: var(--overlay-selected);
    color: var(--accent-primary);
    box-shadow: inset 2px 0 0 var(--accent-primary);
  }

  .sidebar:not(.edit-mode) .nav-item.active .nav-icon {
    color: var(--accent-primary);
  }

  .nav-icon {
    width: 16px;
    text-align: center;
    color: var(--text-secondary);
    font-size: var(--font-size-lg);
    font-family: var(--font-icons);
    flex-shrink: 0;
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nav-badge {
    font-size: var(--font-size-2xs);
    /* Neutral gray pill — count badges no longer borrow the copper accent,
       so copper stays reserved for the active view + primary actions. */
    background: color-mix(in srgb, var(--text-secondary) 20%, transparent);
    color: var(--text-primary);
    border-radius: 8px;
    padding: 0 5px;
    min-width: 16px;
    text-align: center;
    line-height: 16px;
  }

  .provider-status-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-secondary);
    margin-right: 4px;
    vertical-align: middle;
  }

  .provider-status-dot.connected {
    background: var(--accent-green);
  }

  .spacer {
    flex: 1;
  }

  .collapse-btn .nav-icon {
    font-size: var(--font-size-sm);
  }

  /* Edit-mode row layout: [icon][label][eye] */
  .edit-row {
    display: flex;
    align-items: center;
  }

  .eye-toggle {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-family: var(--font-icons);
    font-size: var(--font-size-md);
    cursor: pointer;
    padding: 0 4px;
  }

  .eye-toggle:hover:not([disabled]) {
    color: var(--text-primary);
  }

  .eye-toggle[disabled] {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .nav-item--hidden {
    opacity: 0.5;
  }

  .nav-item--hidden .nav-label {
    text-decoration: line-through;
  }

  /* Collapsed-mode tooltip: fixed-positioned so it escapes the
     sidebar's overflow-y scroll clipping. Mirrors ui/Tooltip.svelte's
     visual language (popover bg, border, --shadow-overlay). */
  .collapsed-tooltip {
    position: fixed;
    transform: translateY(-50%);
    z-index: 1000;
    padding: 4px 8px;
    background: var(--bg-toolbar);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    line-height: 1.4;
    white-space: nowrap;
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: var(--shadow-overlay);
    pointer-events: none;
    user-select: none;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
