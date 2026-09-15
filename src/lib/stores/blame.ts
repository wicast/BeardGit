/**
 * Blame & file history stores.
 *
 * Manages per-line blame annotations and file commit history.
 * Both are loaded together when the blame view is opened, and
 * the user can switch between "blame" and "history" tabs.
 */

import { getErrorMessage } from "$lib/api/errors";
import { writable } from 'svelte/store';
import { blameFile, fileHistory } from '$lib/api/tauri';
import type { BlameLine, FileHistoryEntry } from '$lib/types';

/** Path of the file currently being blamed. */
export const blamePath = writable<string | null>(null);

/** Optional commit OID to view blame at (null = HEAD). */
export const blameOid = writable<string | null>(null);

/** Per-line blame annotations for the current file. */
export const blameLines = writable<BlameLine[]>([]);

/** True while blame data is being fetched. */
export const blameLoading = writable(false);

/** Error message if blame fetch failed. */
export const blameError = writable<string | null>(null);

/** Commit history entries for the current file. */
export const fileHistoryEntries = writable<FileHistoryEntry[]>([]);

/** True while file history is being fetched. */
export const fileHistoryLoading = writable(false);

/** Active tab within the blame view. */
export const blameActiveTab = writable<'blame' | 'history'>('blame');

/** The view the user was on before entering blame, for back navigation. */
export const blamePreviousView = writable<string>('graph');

/** Last-wins tokens so a project's in-flight fetches cannot land after switch. */
let blameToken = 0;
let historyToken = 0;

/**
 * Load per-line blame data for a file, optionally at a specific commit.
 */
export async function loadBlame(path: string, oid?: string): Promise<void> {
  const token = ++blameToken;
  blamePath.set(path);
  blameOid.set(oid ?? null);
  blameLoading.set(true);
  blameError.set(null);
  try {
    const lines = await blameFile(path, oid);
    if (token !== blameToken) return;
    blameLines.set(lines);
  } catch (e) {
    if (token !== blameToken) return;
    blameError.set(getErrorMessage(e));
    blameLines.set([]);
  } finally {
    if (token === blameToken) blameLoading.set(false);
  }
}

/**
 * Load the commit history for a file (up to 100 entries).
 */
export async function loadFileHistory(path: string): Promise<void> {
  const token = ++historyToken;
  fileHistoryLoading.set(true);
  try {
    const entries = await fileHistory(path, 100);
    if (token !== historyToken) return;
    fileHistoryEntries.set(entries);
  } catch {
    if (token !== historyToken) return;
    fileHistoryEntries.set([]);
  } finally {
    if (token === historyToken) fileHistoryLoading.set(false);
  }
}

/**
 * Open the blame view for a file. Loads blame + history in parallel.
 * The caller must also set `activeView = "blame"` in +page.svelte.
 */
export async function openBlame(path: string, oid?: string): Promise<void> {
  blameActiveTab.set('blame');
  await Promise.all([
    loadBlame(path, oid),
    loadFileHistory(path),
  ]);
}

/** Reset all blame/history state. Called when leaving a project. */
export function clearBlameState() {
  blameToken++;
  historyToken++;
  blamePath.set(null);
  blameOid.set(null);
  blameLines.set([]);
  blameLoading.set(false);
  blameError.set(null);
  fileHistoryEntries.set([]);
  fileHistoryLoading.set(false);
  blameActiveTab.set('blame');
}
