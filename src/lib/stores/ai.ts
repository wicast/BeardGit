/**
 * AI provider store — detection, actions, and introspection.
 *
 * Actions return TaskId — output streams to the existing task viewer.
 */

import { writable, derived, get } from "svelte/store";
import * as api from "$lib/api/tauri";
import type { AvailableAiProvider, RepoAiStatus, AiProviderKind } from "$lib/types";

// ─── State ───

export const aiProviders = writable<AvailableAiProvider[]>([]);
export const repoAiStatus = writable<RepoAiStatus[]>([]);
export const preferredAiProvider = writable<AiProviderKind | null>(null);

/**
 * Master switch for the whole AI subsystem (Settings → AI).
 *
 * `null` = not yet loaded from persisted config. Consumers split by need:
 * - Startup AI calls gate on the truthy check ("only run when explicitly
 *   on"), so a slow config read can never trigger provider probes.
 * - Surface visibility treats anything-but-`false` as on (see
 *   {@link aiSurfacesVisible}), matching the persisted default.
 *
 * When `false` every AI surface hides (sidebar group, staging AI buttons,
 * statusbar slot, command-palette entries, AI views reroute to graph) and
 * the app shell skips all startup AI calls, so no provider binaries are
 * probed or spawned.
 */
export const aiEnabled = writable<boolean | null>(null);

/**
 * Whether AI affordances (sidebar group, statusbar slot, palette entries)
 * should render. `false` only when the master switch was loaded as off —
 * the unloaded (`null`) phase counts as visible so enabled installs don't
 * see their navigation flicker while config loads.
 */
export const aiSurfacesVisible = derived(aiEnabled, (v) => v !== false);

/**
 * Whether an AI-provider detection pass is currently in progress.
 *
 * Defaults to `true` so the very first paint of `AiSettings` (before
 * `detectAiProviders` has finished its PATH probes) shows a spinner per
 * provider row instead of "Not found" — the `which claude` /
 * `claude --version` subprocesses on a cold cache can take ~1 s.
 * `detectAiProviders` flips this to `false` in its `finally` block.
 */
export const aiProvidersDetecting = writable(true);

/**
 * Whether an AI affordance should render: at least one provider installed
 * AND the subsystem master switch on. Flipping `aiEnabled` off therefore
 * hides every gated AI button (e.g. staging commit-message/review) with
 * no per-component edits.
 */
export const hasAiProvider = derived(
  [aiProviders, aiEnabled],
  ([providers, enabled]) => enabled !== false && providers.length > 0,
);

/** The effective default provider — preferred if available, otherwise first
 * detected CLI agent. HTTP-only providers (`open_ai`) never become the
 * default here: this store feeds interactive/background entry points
 * (background-run dialog, tab-bar AI menu) which require a CLI binary.
 * Headless actions resolve separately via {@link resolveProvider}, which
 * happily falls back to `open_ai` when no CLI tool is installed — and
 * waits for the persisted preference first so a user who picked the API
 * provider never gets a CLI binary spawned behind their back. */
export const defaultAiProvider = derived(
  [aiProviders, preferredAiProvider],
  ([providers, preferred]): AiProviderKind | null => {
    if (preferred && providers.some((p) => p.kind === preferred)) {
      return preferred;
    }
    const cli = providers.filter((p) => !p.is_http);
    return cli.length > 0 ? cli[0].kind : null;
  },
);

/**
 * Providers that ship a CLI binary, i.e. the only ones that can back an
 * interactive terminal or a background worktree run. Interactive entry
 * points (tab-bar AI menu, background-run dialog) iterate this instead of
 * `aiProviders` so the HTTP-only `open_ai` kind is never offered —
 * selecting it there could only ever end in a failed spawn.
 */
export const cliAiProviders = derived(aiProviders, (providers) =>
  providers.filter((p) => !p.is_http),
);

/**
 * `true` when the effective provider is the HTTP-only kind. Under API mode
 * every headless action (commit message, review, analysis, PR description)
 * is served by the configured endpoint, and the CLI-backed surfaces —
 * interactive terminals, background worktree runs, session browsing — are
 * hidden rather than left to fail.
 */
export const apiOnlyMode = derived(
  [aiProviders, preferredAiProvider],
  ([providers, preferred]) => {
    if (preferred) {
      return providers.some((p) => p.kind === preferred && p.is_http);
    }
    return false;
  },
);

// ─── Detection ───

/**
 * Load the AI master switch from persisted config into the store.
 * Called once from the app shell's `onMount`; failure keeps the default.
 */
export async function loadAiEnabled(): Promise<void> {
  try {
    aiEnabled.set(await api.getAiEnabled());
  } catch {
    /* keep default (enabled) */
  }
}

/**
 * Persist the AI master switch and mirror it into the store. When turning
 * the subsystem off, clear detected providers so gated surfaces disappear
 * immediately instead of waiting for the next detection pass.
 */
export async function setAiEnabled(enabled: boolean): Promise<void> {
  await api.setAiEnabled(enabled);
  aiEnabled.set(enabled);
  if (!enabled) {
    aiProviders.set([]);
    preferredAiProvider.set(null);
  }
}

/**
 * Scan PATH for AI tool binaries and update the store.
 *
 * By default the backend decides whether to probe CLI binaries at all:
 * when the persisted preferred provider is the HTTP-only `open_ai` kind
 * (API mode) it skips the `codex --version` / `claude --version` spawns
 * entirely, so app startup never launches an agent binary the user chose
 * not to use. Pass `{ probeCli: true }` to force the full pass — the
 * Settings page does this because opening it is an explicit user action.
 *
 * Flips `aiProvidersDetecting` to `true` for the duration so the Settings
 * page can render a spinner per row while the two IPC calls + their
 * subprocess probes complete. Always clears the flag in the `finally`
 * block so a failure doesn't leave the UI stuck.
 */
export async function detectAiProviders(options?: {
  probeCli?: boolean;
}): Promise<void> {
  // Master switch off (or not yet loaded) → never probe. The backend
  // command short-circuits too; this avoids the IPC round-trip entirely.
  if (get(aiEnabled) !== true) {
    aiProvidersDetecting.set(false);
    return;
  }
  aiProvidersDetecting.set(true);
  try {
    await api.aiRefreshDetection(options?.probeCli);
    const providers = await api.aiGetProviders();
    aiProviders.set(providers ?? []);
  } finally {
    aiProvidersDetecting.set(false);
  }
}

/**
 * Whether {@link preferredAiProvider} holds the persisted value yet.
 *
 * Headless actions must not resolve a provider before this is true: the
 * store starts as `null`, and a `null` preference means "auto" — which
 * picks the first *detected CLI* provider. On a cold start that is
 * exactly the window in which a user who picked the API provider would
 * silently get `codex` spawned instead.
 */
let preferenceLoaded = false;

/** In-flight loader shared by concurrent callers of {@link ensureProviderState}. */
let stateLoader: Promise<void> | null = null;

/**
 * Block until the provider list and the persisted preference are both in
 * the stores.
 *
 * Every provider-resolution path funnels through here. Detection is only
 * re-run when the list is still empty (startup beat us to it in the
 * common case, so this is usually a single cheap preference read).
 * Failures are swallowed — the caller's own "no provider detected" error
 * is a better message than whatever the IPC layer raised.
 */
async function ensureProviderState(): Promise<void> {
  if (preferenceLoaded && get(aiProviders).length > 0) return;
  if (!stateLoader) {
    stateLoader = (async () => {
      try {
        if (get(aiEnabled) === null) {
          await loadAiEnabled();
        }
        if (get(aiEnabled) !== false && get(aiProviders).length === 0) {
          await detectAiProviders();
        }
        if (!preferenceLoaded) {
          await loadPreferredProvider();
        }
      } catch {
        // Leave the stores as they are; resolution reports the real problem.
      } finally {
        stateLoader = null;
      }
    })();
  }
  await stateLoader;
}

/** Load the preferred AI provider from persisted config. */
export async function loadPreferredProvider(): Promise<void> {
  try {
    const pref = await api.aiGetPreferredProvider();
    preferredAiProvider.set((pref ?? null) as AiProviderKind | null);
  } finally {
    preferenceLoaded = true;
  }
}

/** Set and persist the preferred AI provider. Pass `null` to reset to auto-detect. */
export async function setPreferredProvider(provider: AiProviderKind | null): Promise<void> {
  await api.aiSetPreferredProvider(provider);
  preferredAiProvider.set(provider);
  preferenceLoaded = true;
}

/** Refresh AI status for the current repo. */
export async function refreshRepoAiStatus(): Promise<void> {
  try {
    const status = await api.aiGetRepoStatus();
    repoAiStatus.set(status);
  } catch {
    repoAiStatus.set([]);
  }
}

// ─── Headless Actions ───

/**
 * Resolve which provider a headless action should use.
 *
 * Waits for the persisted preference to land before falling back to
 * "auto", so picking the API provider can never be silently overridden by
 * an installed `codex` / `claude` binary during the startup window.
 */
export async function resolveProvider(): Promise<AiProviderKind> {
  await ensureProviderState();
  const providers = get(aiProviders);
  if (providers.length === 0) {
    throw new Error("No AI provider detected");
  }
  const preferred = get(preferredAiProvider);
  if (preferred && providers.some((p) => p.kind === preferred)) {
    return preferred;
  }
  return providers[0].kind;
}

export async function aiGenerateCommitMessage(provider?: string): Promise<number> {
  const p = provider ?? (await resolveProvider());
  return api.aiGenerateCommitMessage(p);
}

export async function aiAnalyzeCode(
  content: string,
  question: string,
  provider?: string,
): Promise<number> {
  const p = provider ?? (await resolveProvider());
  return api.aiAnalyzeCode(p, content, question);
}

export async function aiGeneratePrDescription(provider?: string): Promise<number> {
  const p = provider ?? (await resolveProvider());
  return api.aiGeneratePrDescription(p);
}

export async function aiReviewCode(diff: string, provider?: string): Promise<number> {
  const p = provider ?? (await resolveProvider());
  return api.aiReviewCode(p, diff);
}

export async function aiReviewPr(diff: string, provider?: string): Promise<number> {
  const p = provider ?? (await resolveProvider());
  return api.aiReviewPr(p, diff);
}

// ─── Interactive Launch ───

export async function aiLaunchInteractive(provider?: string): Promise<number> {
  const p = provider ?? (await resolveProvider());
  return api.aiLaunchInteractive(p);
}

export async function aiLaunchWorktree(
  provider?: string,
  name?: string,
): Promise<number | null> {
  const p = provider ?? (await resolveProvider());
  return api.aiLaunchWorktree(p, name);
}

// ─── Introspection (re-export from API) ───

export const aiListWorktrees = api.aiListWorktrees;
export const aiCleanupWorktree = api.aiCleanupWorktree;
export const aiGetConfigFiles = api.aiGetConfigFiles;
