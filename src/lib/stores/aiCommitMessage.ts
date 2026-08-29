/**
 * AI commit-message generation, orchestrated per project.
 *
 * This used to live inside `StagingArea.svelte`. That made the result a
 * hostage of the component's lifetime: `StagingArea` unmounts whenever
 * the user switches project or view, so a generation kicked off in one
 * project either filled a box that was already gone or — after the user
 * came back — never filled anything at all.
 *
 * Ownership moves here instead. The component only fires
 * {@link generateCommitMessage}; this module tracks the in-flight task
 * per project path and writes the result into the {@link commitDrafts}
 * store, which outlives every view. Switching projects mid-generation is
 * now lossless: the user comes back to a filled commit box.
 */

import { writable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as m from "$lib/paraglide/messages";
import { getTasks, getTaskOutput } from "$lib/api/tauri";
import { aiGenerateCommitMessage } from "$lib/stores/ai";
import { setDraft } from "$lib/stores/commitDraft";
import { addToast } from "$lib/stores/toast";
import { selectTask } from "$lib/stores/taskPanel";
import { stripAnsi } from "$lib/utils/strip-ansi";
import type { TaskInfo } from "$lib/types";

/** Project paths with a generation in flight. Value is the driving task. */
const inFlight = new Map<string, number>();

/** Task ids still streaming, mapped back to the project that asked. */
const pendingByTask = new Map<number, string>();

/**
 * Project paths currently generating, for the button spinner.
 *
 * Read through the store rather than {@link inFlight} so components
 * re-render on transition — and so a spinner survives a remount.
 */
export const aiCommitGenerating = writable<Record<string, boolean>>({});

// ─── Result harvesting ───

/** Split a full commit message into subject + body (first blank line wins). */
function splitMessage(msg: string): { summary: string; description: string } {
  const nl = msg.indexOf("\n");
  if (nl === -1) return { summary: msg, description: "" };
  return {
    summary: msg.slice(0, nl),
    description: msg.slice(nl + 1).replace(/^\n+/, ""),
  };
}

/**
 * Read a finished task's output straight from the backend.
 *
 * Deliberately not reading the `taskOutput` store: the HTTP provider
 * completes the task *inside* the invoke, so its `task-output` lines are
 * emitted before anyone can be subscribed, and the local buffer stays
 * empty. `get_task_output` is the one source that's correct for both the
 * HTTP and the CLI path.
 */
async function readTaskText(taskId: number): Promise<string> {
  const lines = await getTaskOutput(taskId);
  return stripAnsi(lines.map((l) => l.text).join("\n").trim());
}

/**
 * Settle one task: fill the draft on success, toast on failure.
 *
 * Safe to call more than once for the same task (the authoritative
 * snapshot path and the event path can both reach it) — the second call
 * finds nothing in {@link pendingByTask} and returns immediately.
 */
async function settle(projectPath: string, taskId: number, status: TaskInfo["status"]) {
  pendingByTask.delete(taskId);
  finish(projectPath);

  if (status.state === "completed") {
    const cleaned = await readTaskText(taskId).catch(() => "");
    if (cleaned) {
      const parts = splitMessage(cleaned);
      setDraft(projectPath, {
        summary: parts.summary,
        description: parts.description,
      });
    }
    // Keep the drawer's cursor + buffer in sync for after-the-fact viewing.
    void selectTask(taskId);
    return;
  }

  if (status.state === "failed") {
    addToast({
      type: "error",
      message: m.ai_commit_message_failed({ error: status.error }),
      details: status.error,
    });
    void selectTask(taskId);
  }
  // queued / running / cancelled: nothing to harvest or report.
}

function begin(projectPath: string) {
  aiCommitGenerating.update((map) => ({ ...map, [projectPath]: true }));
}

function finish(projectPath: string) {
  inFlight.delete(projectPath);
  aiCommitGenerating.update((map) => {
    if (!map[projectPath]) return map;
    const next = { ...map };
    delete next[projectPath];
    return next;
  });
}

// ─── Event bridge ───

let unlistenCompleted: UnlistenFn | null = null;
let unlistenFailed: UnlistenFn | null = null;

function onTaskEvent(info: TaskInfo) {
  const projectPath = pendingByTask.get(info.id);
  if (projectPath === undefined) return;
  void settle(projectPath, info.id, info.status);
}

/**
 * Register process-wide task listeners.
 *
 * Only the CLI providers still need this — they stream a child process,
 * so the terminal state arrives after the invoke returned. The bridge is
 * installed lazily on first use and stays for the session: it is keyed by
 * task id, so it costs nothing when no generation is pending.
 */
async function ensureBridge() {
  if (unlistenCompleted) return;
  unlistenCompleted = await listen<TaskInfo>("task-completed", (e) => onTaskEvent(e.payload));
  unlistenFailed = await listen<TaskInfo>("task-failed", (e) => onTaskEvent(e.payload));
}

/** Tear the bridge down. Exposed for tests and app shutdown. */
export function stopAiCommitBridge(): void {
  unlistenCompleted?.();
  unlistenFailed?.();
  unlistenCompleted = null;
  unlistenFailed = null;
  pendingByTask.clear();
}

// ─── Public entry point ───

/**
 * Generate a commit message for `projectPath` and write it into that
 * project's draft.
 *
 * Re-entrant per project: a second call for a path that is already
 * generating is a no-op, so double-clicks and keyboard repeats can't
 * stack duplicate API calls.
 */
export async function generateCommitMessage(projectPath: string): Promise<void> {
  if (!projectPath || inFlight.has(projectPath)) return;
  // Claim the slot before the first `await` so a double-click during the
  // invoke can't start a second generation for the same project.
  inFlight.set(projectPath, -1);
  begin(projectPath);

  // Install the event bridge BEFORE the task exists. Awaiting it after
  // the invoke would leave a window in which a fast CLI task's terminal
  // event fires with nobody listening.
  await ensureBridge();

  let taskId: number;
  try {
    taskId = await aiGenerateCommitMessage();
  } catch {
    finish(projectPath);
    return;
  }
  inFlight.set(projectPath, taskId);

  // Authoritative snapshot: the HTTP provider finishes the task inside
  // the invoke, so by the time we get here it may already be done. Read
  // the state from the backend rather than trusting event ordering.
  const info = await getTasks()
    .then((all) => all.find((t) => t.id === taskId))
    .catch(() => undefined);

  if (info && (info.status.state === "completed" || info.status.state === "failed")) {
    await settle(projectPath, taskId, info.status);
    return;
  }

  // Still running (CLI providers): hand off to the event bridge. No
  // `await` between this and the snapshot read above, so an event that
  // landed in the meantime is picked up by the snapshot instead — and
  // the bridge was already listening for anything later. The spinner
  // stays on until the terminal event arrives; navigating away is safe
  // because `settle` writes the draft, not the component.
  pendingByTask.set(taskId, projectPath);
}

/** Whether a generation is in flight for `projectPath`. */
export function isGeneratingCommitMessage(projectPath: string): boolean {
  return inFlight.has(projectPath);
}
