/**
 * Per-project commit-message drafts.
 *
 * The commit box used to keep `summary` / `description` in component-local
 * `$state`, so anything typed — or anything an AI provider generated —
 * evaporated the moment `StagingArea` unmounted (switch project, switch
 * view). Drafts live here instead: in memory for the whole session and
 * mirrored to localStorage so a restart restores them.
 *
 * Keyed by absolute project path, so every open project keeps its own
 * draft and switching tabs is lossless.
 */

import { writable, get } from "svelte/store";
import { debounce } from "$lib/utils/debounce";

/** One project's in-progress commit message. */
export interface CommitDraft {
  /** Conventional-commit subject line. */
  summary: string;
  /** Optional body, separated from the subject by a blank line. */
  description: string;
  /** Whether the next commit amends HEAD instead of creating one. */
  isAmend: boolean;
  /**
   * What the user had typed before flipping Amend on. Restored when they
   * flip it back off, so toggling amend is never destructive.
   */
  savedSummary: string;
  savedDescription: string;
  /** Epoch ms of the last edit — used to evict the oldest drafts. */
  updatedAt: number;
}

export type CommitDraftMap = Record<string, CommitDraft>;

/** localStorage key. Bump the suffix if the shape ever changes. */
const STORAGE_KEY = "beardgit:commit-drafts:v1";

/**
 * Cap on retained drafts. A long-lived install can accumulate a draft per
 * repo ever opened; without a cap the blob grows without bound. The oldest
 * by `updatedAt` are dropped first.
 */
const MAX_DRAFTS = 100;

/** Draft shown for a project with nothing stored yet. */
export const EMPTY_DRAFT: CommitDraft = {
  summary: "",
  description: "",
  isAmend: false,
  savedSummary: "",
  savedDescription: "",
  updatedAt: 0,
};

/** Live drafts, keyed by project path. */
export const commitDrafts = writable<CommitDraftMap>({});

// ─── Persistence ───

/**
 * Trim the map to `MAX_DRAFTS` and drop entries with no content worth
 * restoring. An untouched draft (empty everything, amend off) is pure
 * noise — keeping it would make an empty commit box look like a restore.
 */
function prune(drafts: CommitDraftMap): CommitDraftMap {
  const entries = Object.entries(drafts).filter(([, d]) => isMeaningful(d));
  if (entries.length <= MAX_DRAFTS) return Object.fromEntries(entries);
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_DRAFTS));
}

/** Whether a draft holds anything the user would miss. */
function isMeaningful(d: CommitDraft): boolean {
  return (
    d.summary.trim().length > 0 ||
    d.description.trim().length > 0 ||
    d.savedSummary.trim().length > 0 ||
    d.savedDescription.trim().length > 0
  );
}

/** Write the map to localStorage. Never throws — persistence is best-effort. */
function persistNow(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const drafts = prune(get(commitDrafts));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Quota exceeded or storage disabled (private mode) — drafts stay in
    // memory for this session, which is the guarantee that matters.
  }
}

/** Debounced so typing in the commit box doesn't hit storage per keystroke. */
const persist = debounce(persistNow, 400);

/**
 * Restore drafts persisted by a previous session.
 *
 * Called once from the app shell's `onMount`. Malformed or stale JSON is
 * ignored rather than thrown — a corrupt blob should cost the user their
 * drafts, not their app.
 */
export function loadCommitDrafts(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const drafts: CommitDraftMap = {};
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      const d = value as Partial<CommitDraft> | null;
      if (!d || typeof d !== "object") continue;
      drafts[path] = {
        summary: typeof d.summary === "string" ? d.summary : "",
        description: typeof d.description === "string" ? d.description : "",
        isAmend: d.isAmend === true,
        savedSummary: typeof d.savedSummary === "string" ? d.savedSummary : "",
        savedDescription: typeof d.savedDescription === "string" ? d.savedDescription : "",
        updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
      };
    }
    commitDrafts.set(drafts);
  } catch {
    /* ignore corrupt storage */
  }
}

/**
 * Write any debounced changes out immediately.
 *
 * Wired to the window `beforeunload` handler so a quit right after an edit
 * still lands on disk; `debounce` alone would drop the last 400 ms.
 */
export function flushCommitDrafts(): void {
  persistNow();
}

// ─── Reads ───

/**
 * The draft for `projectPath`, or {@link EMPTY_DRAFT} when it has none.
 *
 * Returns the shared empty object rather than a fresh one so components
 * can compare by identity and `$derived` stays stable across renders.
 */
export function getDraft(projectPath: string): CommitDraft {
  if (!projectPath) return EMPTY_DRAFT;
  return get(commitDrafts)[projectPath] ?? EMPTY_DRAFT;
}

// ─── Writes ───

/**
 * Merge `patch` into the draft for `projectPath`, creating it if needed.
 *
 * Stamps `updatedAt` on every write — the prune order and the restore
 * both depend on it, and callers shouldn't have to remember.
 */
export function setDraft(projectPath: string, patch: Partial<CommitDraft>): void {
  if (!projectPath) return;
  commitDrafts.update((drafts) => {
    const prev = drafts[projectPath] ?? EMPTY_DRAFT;
    const next: CommitDraft = { ...prev, ...patch, updatedAt: Date.now() };
    // Nothing but the timestamp changed → skip the store notification so
    // inputs don't re-render on every no-op write.
    if (
      next.summary === prev.summary &&
      next.description === prev.description &&
      next.isAmend === prev.isAmend &&
      next.savedSummary === prev.savedSummary &&
      next.savedDescription === prev.savedDescription
    ) {
      return drafts;
    }
    persist();
    return { ...drafts, [projectPath]: next };
  });
}

/** Drop the draft for `projectPath` (called after a successful commit). */
export function clearDraft(projectPath: string): void {
  if (!projectPath) return;
  commitDrafts.update((drafts) => {
    if (!(projectPath in drafts)) return drafts;
    const next = { ...drafts };
    delete next[projectPath];
    persist();
    return next;
  });
}

/** Test-only: reset the store and the persisted blob. */
export function resetCommitDrafts(): void {
  commitDrafts.set({});
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
