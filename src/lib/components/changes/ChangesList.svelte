<script lang="ts">
  import type { FileStatus, FileDiffStat } from "../../types";
  import * as m from "$lib/paraglide/messages";
  import ContextMenu from "../common/ContextMenu.svelte";
  import type { MenuItem } from "../common/ContextMenu.svelte";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import FileStatusBadge from "../common/FileStatusBadge.svelte";
  import { openBlame, blameActiveTab } from "$lib/stores/blame";
  import { doStashPush } from "$lib/stores/stashes";
  import { unstagedSelection, stagedSelection } from "$lib/stores/changesSelection";
  import { cleanPaths, discardFiles, revealInFileManager } from "$lib/api/tauri";
  import { addGitignorePattern } from "$lib/api/tauri";
  import { runMutation } from "$lib/api/runMutation";
import { addToast } from "$lib/stores/toast";
  import { Button, Checkbox } from "$lib/components/ui";
  import { activeViewStore } from "$lib/stores/navigation";
  import { openTab as openEditorTab } from "$lib/stores/fileEditor";
  import { isBatchSelection, batchActionIds, type BatchActionId } from "./changes-menu";
  import {
    buildChangesTree,
    flattenTree,
    changedFilesUnderDir,
    type ChangesTreeNode,
  } from "./changes-tree";
  import { changesTreeView, setChangesTreeView } from "$lib/stores/changesView";

  let {
    files,
    title,
    onStage,
    onUnstage,
    isStaged = false,
    selectedPath = null,
    onFileClick,
    onNavigate,
    stats,
  }: {
    files: FileStatus[];
    title: string;
    onStage?: (paths: string[]) => void;
    onUnstage?: (paths: string[]) => void;
    isStaged?: boolean;
    /** Path whose diff is open in the panel — its row renders highlighted. */
    selectedPath?: string | null;
    onFileClick?: (path: string) => void;
    onNavigate?: (view: string) => void;
    /** Per-file add/del stats keyed by path, for the +N/-N row counts. */
    stats?: Map<string, FileDiffStat>;
  } = $props();

  let contextMenuVisible = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);
  let contextMenuFile = $state<string | null>(null);
  /** Right-clicked directory in tree mode; takes precedence over `contextMenuFile`. */
  let contextMenuDir = $state<string | null>(null);
  let showDeleteConfirm = $state(false);
  let deleteTargetPath = $state<string | null>(null);
  let showDiscardConfirm = $state(false);
  let discardTargetPath = $state<string | null>(null);
  let discardTargetIsUntracked = $state(false);
  let showDiscardSelectedConfirm = $state(false);
  let discardSelectedPaths = $state<string[]>([]);

  // ── Tree view ─────────────────────────────────────────────────────
  // Collapsed-directory set is component-local (both list instances keep
  // their own); the flat/tree MODE is the persisted global preference.
  let collapsedDirs = $state<Set<string>>(new Set());

  function toggleCollapse(path: string) {
    const next = new Set(collapsedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsedDirs = next;
  }

  /** Rows currently on screen. Flat mode = every file at depth 0, so a
   *  single render loop serves both modes and the DOM for a file row is
   *  identical between them. */
  let treeRoots = $derived(buildChangesTree(files));

  /** Changed-file count per directory, accumulated in ONE bottom-up DFS
   *  over the tree (each dir's count = its own subtree total), so the cost
   *  is O(files) per update regardless of directory nesting. */
  let dirCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    const walk = (nodes: ChangesTreeNode[]): number => {
      let sum = 0;
      for (const n of nodes) {
        if (n.kind === "dir") {
          const sub = walk(n.children);
          counts.set(n.path, sub);
          sum += sub;
        } else {
          sum += 1;
        }
      }
      return sum;
    };
    walk(treeRoots);
    return counts;
  });

  let displayRows: { node: ChangesTreeNode; depth: number }[] = $derived.by(() => {
    if ($changesTreeView) {
      return flattenTree(treeRoots, collapsedDirs);
    }
    return files.map((f) => ({ node: { kind: "file", path: f.path, name: f.path, file: f }, depth: 0 }));
  });

  /** Changed-file count beneath a directory (for the folder discard menu). */
  function dirChangedCount(dirPath: string): number {
    return dirCounts.get(dirPath) ?? 0;
  }

  /** Queue a folder discard: expand the directory into its currently-
   *  changed file paths and reuse the batch-discard confirm flow. */
  function discardFolder(dirPath: string) {
    const paths = changedFilesUnderDir(buildChangesTree(files), dirPath);
    if (paths.length === 0) return;
    discardSelectedPaths = paths;
    showDiscardSelectedConfirm = true;
  }

  // Checkbox selection is backed by a store so it PERSISTS across leaving
  // and re-entering the Changes view (see changesSelection.ts). `isStaged`
  // is fixed per instance — it just picks which list's store to read/write.
  let selected = $derived(isStaged ? $stagedSelection : $unstagedSelection);

  function setSelection(next: Set<string>) {
    (isStaged ? stagedSelection : unstagedSelection).set(next);
  }

  let selectedCount = $derived(selected.size);
  let allSelected = $derived(files.length > 0 && selected.size === files.length);
  let someSelected = $derived(selected.size > 0 && selected.size < files.length);

  // Keyboard navigation: `focusIndex` is the arrow-key cursor and
  // `anchorIndex` the fixed end of a Shift range. Both are component-local
  // so the cursor starts fresh each visit (unlike the persisted selection).
  let focusIndex = $state(-1);
  let anchorIndex = $state(-1);
  let listEl = $state<HTMLDivElement | null>(null);

  function toggleFile(path: string, index = -1) {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelection(next);
    if (index >= 0) {
      anchorIndex = index;
      focusIndex = index;
    }
  }

  function toggleAll() {
    setSelection(allSelected ? new Set() : new Set(files.map((f) => f.path)));
  }

  function stageSelected() {
    const paths = [...selected];
    setSelection(new Set());
    onStage?.(paths);
  }

  function unstageSelected() {
    const paths = [...selected];
    setSelection(new Set());
    onUnstage?.(paths);
  }

  /** Add every FILE between two row indices (inclusive) to the selection.
   *  Directory rows never join a range — selection stays a set of paths. */
  function selectRange(a: number, b: number) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const next = new Set(selected);
    for (let i = lo; i <= hi; i++) {
      const row = displayRows[i];
      if (row && row.node.kind === "file") next.add(row.node.path);
    }
    setSelection(next);
  }

  function setFocus(index: number) {
    focusIndex = Math.max(0, Math.min(index, displayRows.length - 1));
    const row = listEl?.querySelector<HTMLElement>(`[data-row-index="${focusIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }

  function handleRowClick(e: MouseEvent, index: number) {
    const row = displayRows[index];
    // Directory rows don't open diffs — their chevron handles collapsing.
    if (!row || row.node.kind === "dir") return;
    // Shift-click selects the range from the anchor to the clicked row
    // instead of opening the diff.
    if (e.shiftKey && anchorIndex >= 0) {
      e.preventDefault();
      selectRange(anchorIndex, index);
      focusIndex = index;
      listEl?.focus();
      return;
    }
    anchorIndex = index;
    focusIndex = index;
    listEl?.focus();
    onFileClick?.(row.node.path);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (displayRows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const from = focusIndex < 0 ? (delta > 0 ? -1 : displayRows.length) : focusIndex;
      const next = Math.max(0, Math.min(from + delta, displayRows.length - 1));
      if (e.shiftKey) {
        if (anchorIndex < 0) anchorIndex = focusIndex < 0 ? next : focusIndex;
        selectRange(anchorIndex, next);
      } else {
        anchorIndex = next;
      }
      setFocus(next);
    } else if (e.key === " ") {
      e.preventDefault();
      const row = displayRows[focusIndex];
      if (!row) return;
      if (row.node.kind === "dir") {
        toggleCollapse(row.node.path);
      } else {
        toggleFile(row.node.path, focusIndex);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = displayRows[focusIndex];
      if (row && row.node.kind === "file") {
        onFileClick?.(row.node.path);
      }
    }
  }

  // Prune selection to paths that still exist (after stage/unstage/refresh)
  // rather than clearing it, so the selection survives refreshes and
  // view switches. A stale keyboard cursor self-heals on the next arrow.
  $effect(() => {
    const present = new Set(files.map((f) => f.path));
    (isStaged ? stagedSelection : unstagedSelection).update((sel) => {
      let changed = false;
      const nextSel = new Set<string>();
      for (const p of sel) {
        if (present.has(p)) nextSel.add(p);
        else changed = true;
      }
      return changed ? nextSel : sel;
    });
  });

  /** Generate smart gitignore pattern suggestions from a file path. */
  function buildGitignorePatterns(filePath: string): { label: string; pattern: string }[] {
    const patterns: { label: string; pattern: string }[] = [];
    const parts = filePath.split("/");
    const filename = parts[parts.length - 1];
    const extIdx = filename.lastIndexOf(".");
    const ext = extIdx > 0 ? filename.substring(extIdx + 1) : null;

    // 1. Ignore by filename (anywhere in repo)
    patterns.push({
      label: m.gitignore_menu_filename({ name: filename }),
      pattern: filename,
    });

    // 2. Ignore by extension
    if (ext) {
      patterns.push({
        label: m.gitignore_menu_extension({ ext }),
        pattern: `*.${ext}`,
      });
    }

    // 3. Ignore exact path
    if (parts.length > 1) {
      patterns.push({
        label: m.gitignore_menu_path(),
        pattern: filePath,
      });
    }

    // 4. Ignore parent directory (if file is nested)
    if (parts.length > 1) {
      const dir = parts[0];
      patterns.push({
        label: m.gitignore_menu_directory({ dir }),
        pattern: `${dir}/`,
      });
    }

    return patterns;
  }

  /** Discard the checkbox selection (tracked reset + untracked delete) as one
   *  batch, after confirmation. */
  function discardSelected() {
    discardSelectedPaths = [...selected];
    showDiscardSelectedConfirm = true;
  }

  /** Build the batch "… Selected (N)" menu items for the current selection. */
  function buildBatchItems(): MenuItem[] {
    const paths = [...selected];
    const count = String(paths.length);
    return batchActionIds(isStaged)
      .map((id: BatchActionId): MenuItem | null => {
        switch (id) {
          case "stage":
            return onStage
              ? { label: m.changes_stage_selected({ count }), action: stageSelected }
              : null;
          case "unstage":
            return onUnstage
              ? { label: m.changes_unstage_selected({ count }), action: unstageSelected }
              : null;
          case "discard":
            return {
              label: m.changes_menu_discard_selected({ count }),
              action: discardSelected,
            };
          case "stash":
            return {
              label: m.changes_menu_stash_selected({ count }),
              action: () => {
                setSelection(new Set());
                void doStashPush(null, paths);
              },
            };
          case "copyPaths":
            return {
              label: m.changes_menu_copy_paths({ count }),
              action: () => navigator.clipboard.writeText(paths.join("\n")),
            };
        }
      })
      .filter((i): i is MenuItem => i !== null);
  }

  function buildContextMenuItems(filePath: string): MenuItem[] {
    const items: MenuItem[] = [];
    const batch = isBatchSelection(selected, filePath);

    if (!isStaged && onStage) {
      items.push({
        label: m.changes_menu_stage(),
        action: () => onStage!([filePath]),
      });
    }

    if (isStaged && onUnstage) {
      items.push({
        label: m.changes_menu_unstage(),
        action: () => onUnstage!([filePath]),
      });
    }

    // Stash the checkbox selection, falling back to the right-clicked file
    // when nothing is checked. When the batch section is showing (≥2 checked,
    // cursor in selection) stash lives there instead, so skip it here.
    if (!batch) {
      const stashPaths = selected.size > 0 ? [...selected] : [filePath];
      items.push({
        label: m.changes_menu_stash_selected({ count: String(stashPaths.length) }),
        action: () => {
          setSelection(new Set());
          void doStashPush(null, stashPaths);
        },
      });
    }

    items.push({
      label: m.changes_menu_copy_path(),
      action: () => navigator.clipboard.writeText(filePath),
    });

    items.push({
      label: m.context_reveal_in_file_manager(),
      action: () =>
        void revealInFileManager(filePath).catch((err) =>
          addToast({ type: "error", message: String(err) }),
        ),
    });

    items.push({
      label: m.editor_open_in_editor(),
      action: () => {
        activeViewStore.set("editor");
        void openEditorTab(filePath);
      },
    });

    items.push({ separator: true });
    items.push({
      label: m.context_blame(),
      action: () => {
        openBlame(filePath);
        onNavigate?.('blame');
      },
    });
    items.push({
      label: m.context_file_history(),
      action: () => {
        openBlame(filePath);
        blameActiveTab.set('history');
        onNavigate?.('blame');
      },
    });

    // Unstaged-only actions: discard, delete (untracked), gitignore patterns
    if (!isStaged) {
      const file = files.find(f => f.path === filePath);
      if (file) {
        items.push({ separator: true });
        items.push({
          label: m.changes_menu_discard(),
          action: () => {
            discardTargetPath = filePath;
            discardTargetIsUntracked = file.status === "new";
            showDiscardConfirm = true;
          },
        });
      }
      if (file && file.status === "new") {
        items.push({
          label: m.changes_menu_delete_file(),
          action: () => {
            deleteTargetPath = filePath;
            showDeleteConfirm = true;
          },
        });
        const patterns = buildGitignorePatterns(filePath);
        for (const p of patterns) {
          items.push({
            label: p.label,
            action: async () => {
              try {
                await runMutation({
                  kind: "gitignore_add",
                  invoke: () => addGitignorePattern(p.pattern),
                  successToast: () => `Added \`${p.pattern}\` to .gitignore`,
                  failureToastPrefix: "Gitignore update failed",
                });
              } catch {
                // runMutation already surfaced the toast.
              }
            },
          });
        }
      }
    }

    // Batch section: the same git actions applied to the whole checkbox
    // selection, gated on ≥2 files checked with the cursor file among them.
    if (batch) {
      items.push({ separator: true });
      items.push(...buildBatchItems());
    }

    return items;
  }

  async function handleConfirmDelete() {
    if (!deleteTargetPath) return;
    const path = deleteTargetPath;
    try {
      await runMutation({
        kind: "clean",
        invoke: () => cleanPaths([path]),
        successToast: () => `Deleted ${path}`,
        failureToastPrefix: "Delete failed",
      });
    } catch {
      // runMutation already surfaced the toast.
    }
    showDeleteConfirm = false;
    deleteTargetPath = null;
  }

  async function handleConfirmDiscard() {
    if (!discardTargetPath) return;
    const path = discardTargetPath;
    const isUntracked = discardTargetIsUntracked;
    try {
      await runMutation<void>({
        kind: "discard",
        invoke: async () => {
          if (isUntracked) await cleanPaths([path]);
          else await discardFiles([path]);
        },
        successToast: () => (isUntracked ? `Deleted ${path}` : `Discarded changes in ${path}`),
        failureToastPrefix: "Discard failed",
      });
    } catch {
      // runMutation already surfaced the toast.
    }
    showDiscardConfirm = false;
    discardTargetPath = null;
    discardTargetIsUntracked = false;
  }

  async function handleConfirmDiscardSelected() {
    const paths = discardSelectedPaths;
    if (paths.length === 0) return;
    setSelection(new Set());
    try {
      // `discard_files` handles the mix in one guarded call: tracked files
      // reset to the index, untracked files are deleted from disk.
      await runMutation<void>({
        kind: "discard",
        invoke: () => discardFiles(paths),
        successToast: () => `Discarded changes in ${paths.length} files`,
        failureToastPrefix: "Discard failed",
      });
    } catch {
      // runMutation already surfaced the toast.
    }
    showDiscardSelectedConfirm = false;
    discardSelectedPaths = [];
  }

  function openContextMenu(e: MouseEvent, filePath: string) {
    e.preventDefault();
    contextMenuFile = filePath;
    contextMenuDir = null;
    contextMenuX = e.clientX;
    contextMenuY = e.clientY;
    contextMenuVisible = true;
  }

  /** Context menu for a DIRECTORY row in tree mode. Unstaged lists offer
   *  folder discard (expanded to the currently-changed files beneath the
   *  directory and run through the same guarded `discard_files` call);
   *  both list kinds can copy the folder path. */
  function openDirContextMenu(e: MouseEvent, dirPath: string) {
    e.preventDefault();
    contextMenuFile = null;
    contextMenuDir = dirPath;
    contextMenuX = e.clientX;
    contextMenuY = e.clientY;
    contextMenuVisible = true;
  }

  function buildDirContextMenuItems(dirPath: string): MenuItem[] {
    const items: MenuItem[] = [];
    const count = dirChangedCount(dirPath);
    if (!isStaged && count > 0) {
      items.push({
        label: m.changes_menu_discard_folder({ count: String(count) }),
        action: () => discardFolder(dirPath),
      });
    }
    items.push({
      label: m.context_reveal_in_file_manager(),
      action: () =>
        void revealInFileManager(dirPath).catch((err) =>
          addToast({ type: "error", message: String(err) }),
        ),
    });
    items.push({
      label: m.changes_menu_copy_path(),
      action: () => navigator.clipboard.writeText(`${dirPath}/`),
    });
    return items;
  }
</script>

<div class="changes-list" data-testid={isStaged ? "changes-list-staged" : "changes-list-unstaged"}>
  <div class="list-header">
    <div class="header-left">
      <Checkbox
        checked={allSelected}
        indeterminate={someSelected}
        disabled={files.length === 0}
        ariaLabel={m.changes_select_all()}
        onclick={toggleAll}
      />
      <span class="list-title">{title}</span>
      <span class="file-count">{files.length}</span>
    </div>
    {#if isStaged && onUnstage}
      {#if selectedCount > 0}
        <Button variant="neutral" size="sm" testid="unstage-selected-btn" onclick={unstageSelected}>
          {m.changes_unstage_selected({ count: String(selectedCount) })}
        </Button>
      {:else}
        <Button variant="neutral" size="sm" testid="unstage-all-btn" onclick={() => onUnstage(files.map(f => f.path))}>
          {m.changes_unstage_all()}
        </Button>
      {/if}
    {/if}
    {#if !isStaged && onStage}
      {#if selectedCount > 0}
        <Button variant="primary" size="sm" testid="stage-selected-btn" onclick={stageSelected}>
          {m.changes_stage_selected({ count: String(selectedCount) })}
        </Button>
      {:else}
        <Button variant="primary" size="sm" testid="stage-all-btn" onclick={() => onStage(files.map(f => f.path))}>
          {m.changes_stage_all()}
        </Button>
      {/if}
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="file-list" role="list" tabindex="0" bind:this={listEl} onkeydown={handleKeydown}>
    {#each displayRows as row, i ((row.node.kind === "dir" ? "dir:" : "file:") + row.node.path)}
      {@const node = row.node}
      {@const stat = node.kind === "file" ? stats?.get(node.path) : undefined}
      <div
        class="file-item"
        class:dir-item={node.kind === "dir"}
        class:selected={node.kind === "file" && node.path === selectedPath}
        class:focused={i === focusIndex}
        role="listitem"
        data-row-index={i}
        data-row-kind={node.kind}
        data-testid={(node.kind === "dir" ? "dir-row-" : "file-row-") + node.path.replace(/\//g, '-')}
        style:padding-left="{12 + row.depth * 14}px"
        oncontextmenu={(e) =>
          node.kind === "dir" ? openDirContextMenu(e, node.path) : openContextMenu(e, node.path)}
      >
        {#if node.kind === "dir"}
          <!-- Directory row: chevron toggles collapse; no checkbox (selection
               stays a set of file paths), no stage/unstage quick-actions. -->
          <button
            class="dir-btn"
            onclick={() => toggleCollapse(node.path)}
            aria-label={m.changes_tree_toggle_folder({ path: node.path })}
            data-testid={"dir-toggle-" + node.path.replace(/\//g, '-')}
          >
            <span class="chev nf" class:open={!collapsedDirs.has(node.path)}>{"\uE316"}</span>
            <span class="dir-name">{node.name}</span>
          </button>
          <span class="dir-count">{dirChangedCount(node.path)}</span>
        {:else}
          <Checkbox
            checked={selected.has(node.path)}
            ariaLabel={node.path}
            onclick={(e) => { e.stopPropagation(); listEl?.focus(); toggleFile(node.path, i); }}
          />
          <button
            class="file-btn"
            onclick={(e) => handleRowClick(e, i)}
          >
            <FileStatusBadge status={node.file.status} />
            <span class="file-path">{row.depth > 0 ? node.name : node.path}</span>
            {#if stat}
              {#if stat.binary}
                <span class="file-stat file-stat-binary">{m.diff_binary_short()}</span>
              {:else}
                {#if stat.additions > 0}
                  <span class="file-stat file-stat-add">+{stat.additions}</span>
                {/if}
                {#if stat.deletions > 0}
                  <span class="file-stat file-stat-del">-{stat.deletions}</span>
                {/if}
              {/if}
            {/if}
          </button>
          {#if isStaged && onUnstage}
            <span class="item-action" role="button" tabindex="0" onclick={(e) => { e.stopPropagation(); onUnstage([node.path]); }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onUnstage([node.path]); } }}>&#8722;</span>
          {/if}
          {#if !isStaged && onStage}
            <span class="item-action" role="button" tabindex="0" onclick={(e) => { e.stopPropagation(); onStage([node.path]); }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onStage([node.path]); } }}>+</span>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
</div>

<ContextMenu
  items={contextMenuDir
    ? buildDirContextMenuItems(contextMenuDir)
    : contextMenuFile
      ? buildContextMenuItems(contextMenuFile)
      : []}
  x={contextMenuX}
  y={contextMenuY}
  visible={contextMenuVisible}
  onClose={() => { contextMenuVisible = false; contextMenuDir = null; }}
/>

{#if showDeleteConfirm && deleteTargetPath}
  <ConfirmDialog
    title={m.changes_menu_delete_confirm_title()}
    message={m.changes_menu_delete_confirm_message({ path: deleteTargetPath })}
    destructive={true}
    onConfirm={handleConfirmDelete}
    onCancel={() => { showDeleteConfirm = false; deleteTargetPath = null; }}
  />
{/if}

{#if showDiscardConfirm && discardTargetPath}
  <ConfirmDialog
    title={discardTargetIsUntracked
      ? m.changes_menu_delete_confirm_title()
      : m.changes_menu_discard_confirm_title()}
    message={discardTargetIsUntracked
      ? m.changes_menu_delete_confirm_message({ path: discardTargetPath })
      : m.changes_menu_discard_confirm_message({ path: discardTargetPath })}
    destructive={true}
    onConfirm={handleConfirmDiscard}
    onCancel={() => { showDiscardConfirm = false; discardTargetPath = null; discardTargetIsUntracked = false; }}
  />
{/if}

{#if showDiscardSelectedConfirm && discardSelectedPaths.length > 0}
  <ConfirmDialog
    title={m.changes_menu_discard_confirm_title()}
    message={m.changes_menu_discard_selected_confirm_message({ count: String(discardSelectedPaths.length) })}
    destructive={true}
    onConfirm={handleConfirmDiscardSelected}
    onCancel={() => { showDiscardSelectedConfirm = false; discardSelectedPaths = []; }}
  />
{/if}

<style>
  .changes-list {
    display: flex;
    flex-direction: column;
  }

  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .list-title {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .file-count {
    font-size: var(--font-size-2xs);
    color: var(--text-secondary);
    background: var(--overlay-hover);
    padding: 1px 6px;
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
    min-width: 18px;
    text-align: center;
  }

  .file-list {
    overflow-y: auto;
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 12px;
    width: 100%;
    border-left: 2px solid transparent;
    transition: background 0.1s ease, border-color 0.1s ease;
  }

  .file-item:hover {
    background: var(--overlay-hover);
    border-left-color: var(--accent-primary);
  }

  /* Row whose diff is open in the panel. Mirrors the selected style of
     `common/FileChangeList.svelte` so both file lists read the same. */
  .file-item.selected {
    background: var(--overlay-accent-blue);
    border-left-color: var(--accent-primary);
  }

  /* Keyboard-navigation cursor (arrow keys) — a thin ring, distinct from
     `.selected` (the open file's filled background). */
  .file-item.focused {
    outline: 1px solid var(--accent-primary);
    outline-offset: -1px;
    border-radius: 2px;
  }

  .file-list:focus {
    outline: none;
  }

  .file-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    text-align: left;
    padding: 2px 0;
  }

  .file-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-stat {
    flex-shrink: 0;
    font-size: var(--font-size-2xs);
    font-family: 'Fira Code', var(--font-mono), monospace;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .file-stat-add {
    color: var(--accent-green);
  }

  .file-stat-del {
    color: var(--accent-red);
  }

  .file-stat-binary {
    color: var(--text-secondary);
  }

  .item-action {
    opacity: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    background: var(--overlay-hover);
    border: none;
    border-radius: 4px;
    line-height: 1;
    color: var(--accent-primary);
    cursor: pointer;
    padding: 2px 6px;
    flex-shrink: 0;
    transition: opacity 0.15s ease, background 0.15s ease;
  }

  .file-item:hover .item-action {
    opacity: 1;
  }

  .item-action:hover {
    background: var(--overlay-accent-blue);
  }

  /* ── Tree mode directory rows ─────────────────────────────────────── */

  .dir-item {
    font-weight: 500;
  }

  .dir-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    padding: 2px 0;
  }

  .dir-btn .chev {
    color: var(--text-secondary);
    transition: transform 0.12s ease;
    display: inline-block;
  }

  .dir-btn .chev.open {
    transform: rotate(90deg);
  }

  .dir-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dir-count {
    flex-shrink: 0;
    font-size: var(--font-size-2xs);
    color: var(--text-secondary);
    background: var(--overlay-hover);
    padding: 1px 6px;
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
  }
</style>
