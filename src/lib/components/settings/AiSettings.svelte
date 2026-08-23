<!--
  AiSettings.svelte — AI provider picker + background-run config.

  Phase 4.5 refactor only: same behaviour as the pre-MT-5 version
  (detect providers, pick a preferred one, tune the background
  worktree / concurrency / auto-accept defaults) — now rendered on
  top of the shared `Card` / `SettingSection` / `FormRow` / `Field`
  / `Button` primitives so the inline card CSS disappears.

  Provider rows stay as a bespoke grid because the
  icon-label-status-badge layout is unique to this category and
  doesn't map cleanly to `FormRow`.
-->
<script module lang="ts">
  import type { SettingDescriptor } from "./settings-index";

  export const settingsIndex: SettingDescriptor[] = [
    {
      id: "ai.master-switch",
      label: "Enable AI features",
      description:
        "Master switch for the whole AI subsystem. When off, no AI surface renders and no AI tool is ever launched or probed.",
      category: "ai",
      anchor: "master-switch",
    },
    {
      id: "ai.openai-config",
      label: "OpenAI-compatible endpoint",
      description:
        "Base URL, API key, and model for OpenAI-compatible providers such as a local Ollama server.",
      category: "ai",
      anchor: "openai-config",
    },
    {
      id: "ai.provider",
      label: "Preferred AI provider",
      description:
        "Pick which installed AI tool (Claude Code / Codex / OpenCode) BeardGit uses by default.",
      category: "ai",
      anchor: "provider",
    },
    {
      id: "ai.worktree-root",
      label: "AI worktree root",
      description:
        "Directory where AI background worktrees are created. Relative paths resolve to each repo.",
      category: "ai",
      anchor: "worktree-root",
    },
    {
      id: "ai.concurrency",
      label: "Concurrent background runs",
      description:
        "Maximum number of AI background runs that may execute at once. Extra runs are queued.",
      category: "ai",
      anchor: "concurrency",
    },
    {
      id: "ai.auto-accept",
      label: "Auto-accept AI permission prompts",
      description:
        "Allow AI agents to edit files in the worktree without confirmation — use with care.",
      category: "ai",
      anchor: "auto-accept",
    },
  ];
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import {
    aiProviders,
    aiProvidersDetecting,
    preferredAiProvider,
    detectAiProviders,
    setPreferredProvider,
    loadPreferredProvider,
    loadAiEnabled,
    setAiEnabled,
    aiEnabled,
  } from "$lib/stores/ai";
  import type { AiBackgroundSettings, AiProviderKind, OpenAiConfig } from "$lib/types";
  import {
    aiBackgroundGetSettings,
    aiBackgroundSetSettings,
    getOpenaiConfig,
    setOpenaiConfig,
  } from "$lib/api/tauri";
  import * as m from "$lib/paraglide/messages";
  import {
    Button,
    Card,
    SettingSection,
    FormRow,
    Field,
    Switch,
  } from "$lib/components/ui";
  // ProviderIcon is shared with AiSessions + Spec 4's generic-icon fix.
  import ProviderIcon from "$lib/components/ai-sessions/ProviderIcon.svelte";

  const ALL_KINDS: { kind: AiProviderKind; label: () => string }[] = [
    { kind: "claude_code", label: () => m.ai_settings_provider_claude() },
    { kind: "codex", label: () => m.ai_settings_provider_codex() },
    { kind: "open_code", label: () => m.ai_settings_provider_opencode() },
    { kind: "open_ai", label: () => m.ai_settings_provider_openai() },
  ];

  // ── OpenAI-compatible connection form ─────────────────────────────
  // Defaults mirror the backend's `OpenAiConfig::default()` (local
  // Ollama). The form renders whenever the provider row is selected so
  // users without any CLI agent can still wire up headless actions.
  let oaConfig = $state<OpenAiConfig>({
    base_url: "http://localhost:11434/v1",
    api_key: "",
    model: "",
  });
  let oaSaving = $state(false);
  let oaError = $state<string | null>(null);
  let oaSavedTick = $state(0);

  async function saveOaConfig() {
    oaSaving = true;
    oaError = null;
    try {
      await setOpenaiConfig({
        base_url: oaConfig.base_url.trim(),
        api_key: oaConfig.api_key.trim(),
        model: oaConfig.model.trim(),
      });
      oaSavedTick++;
      setTimeout(() => { oaSavedTick = 0; }, 2000);
    } catch (e) {
      oaError = String(e);
    } finally {
      oaSaving = false;
    }
  }

  let bgSettings = $state<AiBackgroundSettings>({
    worktree_root: null,
    concurrency_cap: 3,
    auto_accept_permissions: false,
  });
  let bgSaving = $state(false);
  let bgError = $state<string | null>(null);

  // Fire-and-forget on mount: the Settings shell paints immediately while
  // the async operations populate their respective stores in the
  // background. `detectAiProviders` runs PATH probes + `--version` calls
  // that can take ~1 s on a cold cache — we render the provider list as
  // "detecting..." during that window, not "Not found". When the master
  // switch (loaded first) is off, detection self-skips and the provider
  // grid below isn't rendered at all.
  onMount(() => {
    void (async () => {
      await loadAiEnabled();
      if ($aiEnabled !== false) {
        void detectAiProviders();
        void loadPreferredProvider();
      }
    })();
    void (async () => {
      try {
        bgSettings = await aiBackgroundGetSettings();
      } catch (e) {
        bgError = String(e);
      }
    })();
    void (async () => {
      try {
        oaConfig = await getOpenaiConfig();
      } catch {
        /* keep defaults */
      }
    })();
  });

  /** Flip the AI subsystem master switch (persists immediately). */
  function handleToggleAiEnabled(e: Event) {
    const enabled = (e.target as HTMLInputElement).checked;
    void setAiEnabled(enabled).catch(() => undefined);
  }

  async function saveBgSettings() {
    bgSaving = true;
    bgError = null;
    try {
      await aiBackgroundSetSettings({
        worktree_root:
          bgSettings.worktree_root && bgSettings.worktree_root.trim().length > 0
            ? bgSettings.worktree_root.trim()
            : null,
        concurrency_cap: Math.max(1, Math.floor(bgSettings.concurrency_cap)),
        auto_accept_permissions: bgSettings.auto_accept_permissions,
      });
    } catch (e) {
      bgError = String(e);
    } finally {
      bgSaving = false;
    }
  }

  async function handleSelect(kind: AiProviderKind) {
    const available = $aiProviders.some((p) => p.kind === kind);
    if (!available) return;
    await setPreferredProvider($preferredAiProvider === kind ? null : kind);
  }

  function isDetected(kind: AiProviderKind): boolean {
    return $aiProviders.some((p) => p.kind === kind);
  }

  function getVersion(kind: AiProviderKind): string | null {
    return $aiProviders.find((p) => p.kind === kind)?.version ?? null;
  }

  function isPreferred(kind: AiProviderKind): boolean {
    if ($preferredAiProvider) return $preferredAiProvider === kind;
    return $aiProviders.length > 0 && $aiProviders[0].kind === kind;
  }
</script>

<Card
  title={m.settings_ai_providers_section_title()}
  description={m.settings_ai_providers_section_description()}
>
  <SettingSection title={m.ai_settings_master_switch_title()}>
    <div data-setting-anchor="master-switch">
      <FormRow
        label={m.ai_settings_master_switch_label()}
        for="ai-master-switch"
        helperText={m.ai_settings_master_switch_hint()}
      >
        <Switch
          id="ai-master-switch"
          checked={$aiEnabled !== false}
          testid="ai-master-switch"
          onchange={handleToggleAiEnabled}
        />
      </FormRow>
    </div>
  </SettingSection>

  {#if $aiEnabled !== false}
  <SettingSection title={m.ai_settings_title()}>
    <div class="provider-list" data-setting-anchor="provider">
      {#each ALL_KINDS as { kind, label } (kind)}
        {@const detected = isDetected(kind)}
        {@const preferred = isPreferred(kind)}
        {@const version = getVersion(kind)}
        {@const detecting = $aiProvidersDetecting && !detected}
        <button
          type="button"
          class="provider-row"
          class:detected
          class:preferred
          disabled={!detected}
          onclick={() => handleSelect(kind)}
        >
          <ProviderIcon provider={kind} size={20} />
          <div class="provider-info">
            <span class="provider-name">{label()}</span>
            {#if kind === "open_ai"}
              <!-- HTTP provider: always "detected" (no binary to probe). -->
              <span class="provider-status">{m.ai_settings_openai_http_hint()}</span>
            {:else if detected && version}
              <span class="provider-version"
                >{m.ai_settings_version({ version })}</span
              >
            {:else if detecting}
              <span class="provider-status detecting">
                <span class="detecting-spinner" aria-hidden="true"></span>
                {m.ai_settings_detecting()}
              </span>
            {:else if !detected}
              <span class="provider-status not-found"
                >{m.ai_settings_not_found()}</span
              >
            {/if}
          </div>
          {#if preferred && detected}
            <span class="preferred-badge"
              >{m.ai_settings_default_provider()}</span
            >
          {:else if detected}
            <span class="detected-badge">{m.ai_settings_detected()}</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if !$aiProvidersDetecting && $aiProviders.length === 0}
      <div class="empty-state">{m.ai_settings_no_providers()}</div>
    {/if}

    <!-- OpenAI-compatible endpoint configuration: shown while that
        provider is the preferred/default one. Headless actions (commit
        message, review, PR description) POST here; interactive
        terminals / background runs stay CLI-only and don't list it. -->
    {#if isPreferred("open_ai") || $preferredAiProvider === "open_ai"}
      <div class="openai-config" data-setting-anchor="openai-config">
        <Field
          label={m.ai_settings_openai_base_url()}
          description={m.ai_settings_openai_base_url_hint()}
          for="oa-base-url"
        >
          <input
            id="oa-base-url"
            class="field-input"
            type="text"
            placeholder="http://localhost:11434/v1"
            bind:value={oaConfig.base_url}
            data-testid="openai-base-url"
          />
        </Field>
        <Field
          label={m.ai_settings_openai_api_key()}
          description={m.ai_settings_openai_api_key_hint()}
          for="oa-api-key"
        >
          <input
            id="oa-api-key"
            class="field-input"
            type="password"
            placeholder=""
            bind:value={oaConfig.api_key}
            data-testid="openai-api-key"
          />
        </Field>
        <Field
          label={m.ai_settings_openai_model()}
          description={m.ai_settings_openai_model_hint()}
          for="oa-model"
        >
          <input
            id="oa-model"
            class="field-input"
            type="text"
            placeholder="llama3.1"
            bind:value={oaConfig.model}
            data-testid="openai-model"
          />
        </Field>
        <div class="openai-actions">
          {#if oaError}
            <span class="error-text" data-testid="openai-save-error">{oaError}</span>
          {:else if oaSavedTick > 0}
            <span class="saved-text" data-testid="openai-saved">{m.ai_settings_openai_saved()}</span>
          {/if}
          <Button variant="primary" size="sm" disabled={oaSaving} onclick={saveOaConfig}>
            {m.ai_settings_openai_save()}
          </Button>
        </div>
      </div>
    {/if}
  </SettingSection>
  {:else}
  <div class="disabled-note" data-testid="ai-disabled-note">
    {m.ai_settings_disabled_note()}
  </div>
  {/if}
</Card>

{#if $aiEnabled !== false}
<Card
  title={m.settings_ai_background_section_title()}
  description={m.settings_ai_background_section_description()}
>
  <SettingSection title={m.settings_ai_background_heading()}>
    <div data-setting-anchor="worktree-root">
      <Field
        label={m.settings_ai_worktree_root_label()}
        description={m.settings_ai_worktree_root_hint()}
        for="bg-root"
      >
        <input
          id="bg-root"
          class="field-input"
          type="text"
          placeholder=".beardgit/ai-worktrees"
          value={bgSettings.worktree_root ?? ""}
          oninput={(e) => {
            bgSettings.worktree_root = e.currentTarget.value;
          }}
          onblur={saveBgSettings}
        />
      </Field>
    </div>

    <div data-setting-anchor="concurrency">
      <FormRow
        label={m.settings_ai_concurrency_label()}
        for="bg-cap"
        helperText={m.settings_ai_concurrency_hint()}
      >
        <input
          id="bg-cap"
          class="field-input short"
          type="number"
          min="1"
          max="32"
          bind:value={bgSettings.concurrency_cap}
          onblur={saveBgSettings}
        />
      </FormRow>
    </div>

    <div data-setting-anchor="auto-accept">
      <FormRow
        label={m.settings_ai_auto_accept_label()}
        for="bg-auto-accept"
        helperText={m.settings_ai_auto_accept_hint()}
      >
        <Switch
          id="bg-auto-accept"
          checked={bgSettings.auto_accept_permissions}
          onchange={(e) => {
            bgSettings.auto_accept_permissions = (e.target as HTMLInputElement).checked;
            saveBgSettings();
          }}
        />
      </FormRow>
    </div>

    {#if bgError}
      <p class="error-text">{bgError}</p>
    {:else if bgSaving}
      <p class="saving-text">…</p>
    {/if}
  </SettingSection>
</Card>
{/if}

<style>
  .disabled-note {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-style: italic;
    padding: 4px 0;
  }

  .openai-config {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 8px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
  }

  .openai-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }

  .saved-text {
    color: var(--accent-green);
    font-size: var(--font-size-xs);
  }

  .provider-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .provider-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-primary);
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s;
    text-align: left;
    width: 100%;
    font-family: inherit;
  }

  .provider-row:hover:not(:disabled) {
    background: var(--overlay-hover);
  }
  .provider-row:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .provider-row.preferred {
    border-color: var(--accent-primary);
    background: var(--overlay-accent-blue);
  }

  .provider-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
  }
  .provider-name {
    font-size: var(--font-size-md);
    font-weight: 500;
    color: var(--text-primary);
  }
  .provider-version {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }
  .provider-status.not-found {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    font-style: italic;
  }
  .provider-status.detecting {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .detecting-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--text-secondary);
    border-top-color: transparent;
    border-radius: 50%;
    animation: ai-settings-spin 0.6s linear infinite;
    opacity: 0.7;
  }
  @keyframes ai-settings-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .preferred-badge {
    font-size: var(--font-size-2xs);
    font-weight: 600;
    color: var(--accent-primary);
    background: var(--overlay-accent-blue);
    padding: 2px 8px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .detected-badge {
    font-size: var(--font-size-2xs);
    color: var(--accent-green);
    background: var(--overlay-accent-green);
    padding: 2px 8px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .empty-state {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-style: italic;
  }

  .field-input {
    padding: 6px 10px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    outline: none;
    box-sizing: border-box;
    width: 100%;
  }

  .field-input.short {
    max-width: 100px;
    width: 100px;
  }

  .field-input:focus {
    border-color: var(--accent-primary);
  }

  .error-text {
    color: var(--accent-red);
    font-size: var(--font-size-sm);
  }

  .saving-text {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
</style>
