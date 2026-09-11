<script lang="ts">
  import SplitView from "../common/SplitView.svelte";
  import TagList from "./TagList.svelte";
  import TagDetail from "./TagDetail.svelte";
  import { refreshTags } from "../../stores/tags";
  import { refreshRemotes } from "../../stores/remotes";

  /**
   * Both panes can push tags, and both read the remote list from
   * `stores/remotes`. Refreshing them together means the picker is
   * populated by the time the list paints, instead of being empty — and the
   * push buttons disabled — until something else happens to load remotes.
   */
  async function refresh(): Promise<void> {
    await Promise.all([refreshTags(), refreshRemotes()]);
  }
</script>

<SplitView refreshFn={refresh} memoryKey="tags.splitWidth">
  {#snippet left()}<TagList />{/snippet}
  {#snippet right()}<TagDetail />{/snippet}
</SplitView>
