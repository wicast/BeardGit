<!--
  Remote picker for tag pushes.

  Rendered by both surfaces that can push tags — the list footer ("Push all
  tags") and the tag detail footer ("Push") — over the single selection in
  `stores/tagPushRemote`. Two pickers, one value: see that module for why
  they are not independent.

  A native `<select>` on purpose. The list is short, the app has no custom
  dropdown primitive to reuse (`ContextMenu` is a pointer-driven popup with
  no listbox semantics), and `select` brings keyboard, screen-reader and
  OS-level popup behaviour that would otherwise all have to be rebuilt.

  Renders nothing when the repository has no remotes: there is nothing to
  choose, and the push buttons next to it are disabled with a tooltip that
  says so.
-->
<script lang="ts">
  import { remotes } from "../../stores/remotes";
  import { tagPushRemote, setTagPushRemote } from "../../stores/tagPushRemote";
  import * as m from "$lib/paraglide/messages";

  let { testid = "tag-push-remote" }: { testid?: string } = $props();
</script>

{#if $remotes.length > 0}
  <select
    class="remote-select"
    value={$tagPushRemote ?? ""}
    aria-label={m.tags_push_remote_label()}
    title={m.tags_push_remote_label()}
    data-testid={testid}
    onchange={(e) => setTagPushRemote(e.currentTarget.value)}
  >
    {#each $remotes as remote (remote.name)}
      <option value={remote.name}>{remote.name}</option>
    {/each}
  </select>
{/if}

<style>
  /* Matches the app's other inline selects (see Settings → Git). The 1px
     border is the same one the buttons beside it carry, so the picker reads
     as part of the control group rather than as a stray form field. */
  .remote-select {
    max-width: 120px;
    padding: 3px 6px;
    background: color-mix(in srgb, var(--text-primary) 4%, transparent);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    font-family: inherit;
    cursor: pointer;
  }

  .remote-select:hover {
    border-color: var(--accent-primary);
  }
</style>
