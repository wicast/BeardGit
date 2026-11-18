<!--
  BusyDialog.svelte — "git is still working" notice for slow operations.

  A single instance is mounted by `+layout.svelte`. It reads the *active*
  repo's busy slice (see `stores/busyOps.ts`), so a checkout grinding through
  a large worktree in one tab never dims another tab — switching tabs swaps
  (or removes) the dialog instead of following the operation.

  Visibility is deliberately not owned here beyond the dismiss handshake:
  `busyDialogVisible` already folds in the 3 s threshold (so fast ops never
  flash a modal) and the user's "run in background" choice. Esc / backdrop and
  the footer button are the same action — hide the notice, keep the work
  running — which is why both route to `hideBusyNotice`.
-->
<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import Button from "./Button.svelte";
  import { activeBusyOps, busyDialogVisible, hideBusyNotice, type BusyOp } from "$lib/stores/busyOps";
  import { activeRepoPath } from "$lib/stores/repo-state";
  import * as m from "$lib/paraglide/messages";

  let visible = $state(false);
  let ops = $state<BusyOp[]>([]);
  let projectPath = $state<string | null>(null);
  let open = $state(false);
  let elapsedSeconds = $state(0);

  $effect(() => {
    const unlistenVisible = busyDialogVisible.subscribe(($v) => (visible = $v));
    const unlistenOps = activeBusyOps.subscribe(($ops) => (ops = $ops));
    const unlistenPath = activeRepoPath.subscribe(($p) => (projectPath = $p));
    return () => {
      unlistenVisible();
      unlistenOps();
      unlistenPath();
    };
  });

  $effect(() => {
    open = visible;
  });

  // Tick once per second while the dialog is up, measured from the *oldest*
  // in-flight op: that is the one the user is waiting on. Re-arming on `ops`
  // keeps the counter honest when a second command joins the batch.
  $effect(() => {
    if (!visible) return;
    const list = ops;
    if (list.length === 0) return;
    const oldest = Math.min(...list.map((op) => op.startedAt));
    const tick = () => {
      elapsedSeconds = Math.max(0, Math.round((Date.now() - oldest) / 1000));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  });

  /** Folder name of the busy repo — the path is what identifies a project. */
  const projectName = $derived.by(() => {
    if (!projectPath) return "";
    const segments = projectPath.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? "";
  });

  /** `reset_soft` → `reset soft`; the kind doubles as the label. */
  const opLabel = $derived(ops[0] ? ops[0].kind.replace(/_/g, " ") : "");

  const queuedLabel = $derived(
    ops.length > 1 ? m.busy_ops_queued({ count: ops.length - 1 }) : "",
  );
</script>

<Dialog bind:open size="sm" title={m.busy_title()} onClose={hideBusyNotice}>
  <div class="busy-body" data-testid="bg-busy-dialog">
    <div class="busy-row">
      <span class="spinner spinner--large" aria-hidden="true"></span>
      <span class="busy-op" data-testid="bg-busy-op">{m.busy_op_running({ op: opLabel })}</span>
      <span class="busy-elapsed" data-testid="bg-busy-elapsed">
        {m.busy_elapsed({ seconds: elapsedSeconds })}
      </span>
    </div>
    {#if queuedLabel}
      <div class="busy-queued" data-testid="bg-busy-queued">{queuedLabel}</div>
    {/if}
    <p class="busy-hint">
      {m.busy_hint({ project: projectName || projectPath || "" })}
    </p>
  </div>
  {#snippet footer()}
    <Button variant="neutral" size="sm" onclick={hideBusyNotice} testid="bg-busy-hide">
      {m.busy_run_in_background()}
    </Button>
  {/snippet}
</Dialog>

<style>
  .busy-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .busy-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .busy-op {
    color: var(--text-primary);
    font-weight: 600;
  }

  .busy-elapsed {
    margin-left: auto;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .busy-queued {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .busy-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }
</style>
