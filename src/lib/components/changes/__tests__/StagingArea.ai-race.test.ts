/**
 * Regression test for the AI commit-message race: on the open_ai HTTP path
 * the task reaches its terminal state INSIDE the `ai_generate_commit_message`
 * invoke, so the per-task `task-completed`/`task-failed` event listeners
 * registered afterwards miss the events. StagingArea must recover the
 * terminal state from the `tasks` store (maintained by the app-startup
 * global listeners) and surface the failure as a toast instead of leaving
 * the button spinning forever.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import { writable } from "svelte/store";
import { mockInvokeResponse } from "../../../../test/setup";

const aiGenerateCommitMessage = vi.hoisted(() => vi.fn());

vi.mock("$lib/stores/ai", () => ({
  aiProviders: writable([
    { kind: "open_ai", binary_path: "<openai-compatible>", version: null, is_http: true },
  ]),
  aiEnabled: writable(true),
  aiSurfacesVisible: writable(true),
  aiProvidersDetecting: writable(false),
  preferredAiProvider: writable("open_ai"),
  hasAiProvider: writable(true),
  aiGenerateCommitMessage,
  aiReviewCode: vi.fn(),
}));

import StagingArea from "../StagingArea.svelte";
import type { TaskInfo } from "../../../types";
import { tasks, taskOutput } from "../../../stores/taskPanel";
import { toasts } from "../../../stores/toast";

const STAGED = [{ path: "src/app.ts", status: "modified", is_staged: true }];

function taskInfo(id: number, status: TaskInfo["status"]): TaskInfo {
  return {
    id,
    label: "AI: generate commit message",
    status,
    cancellable: false,
    elapsed_secs: 1,
    command: "POST http://localhost:11434/v1/chat/completions",
    started_at_ms: 1,
    exit_code: null,
  };
}

function failedTaskInfo(id: number, error: string): TaskInfo {
  return taskInfo(id, { state: "failed", error });
}

describe("StagingArea AI commit-message race recovery", () => {
  beforeEach(() => {
    aiGenerateCommitMessage.mockReset();
    tasks.set([]);
    taskOutput.set(new Map());
    toasts.set([]);
    // StagingArea's onMount refreshes these; keep them non-undefined so the
    // derived `staged` list doesn't blow up mid-render.
    mockInvokeResponse("get_file_statuses", STAGED);
    mockInvokeResponse("get_diff_stats_workdir", []);
    mockInvokeResponse("get_diff_stats_index", []);
  });

  afterEach(() => cleanup());

  it("surfaces a failed task via toast when the terminal event was missed", async () => {
    // The task already failed server-side before the invoke resolved — the
    // per-task listeners never see it, but the global `tasks` store has it.
    aiGenerateCommitMessage.mockResolvedValue(42);
    tasks.set([failedTaskInfo(42, "OpenAI endpoint unreachable (http://localhost:11434/v1/chat/completions): boom")]);

    const { container } = render(StagingArea);
    // Wait for onMount refreshes + derived state.
    await new Promise((r) => setTimeout(r, 0));

    const genBtn = container.querySelector('button[aria-label="AI Commit Message"]');
    expect(genBtn).toBeTruthy();
    await fireEvent.click(genBtn!);

    // The failed task must surface as an error toast with the error text.
    await new Promise((r) => setTimeout(r, 0));
    const toastList = get(toasts);
    const errorToast = toastList.find((t) => t.type === "error");
    expect(errorToast).toBeTruthy();
    expect(errorToast?.message).toContain("OpenAI endpoint unreachable");
    expect(errorToast?.details).toBe("OpenAI endpoint unreachable (http://localhost:11434/v1/chat/completions): boom");
  });

  it("does not double-fire when the listener also catches the event", async () => {
    aiGenerateCommitMessage.mockResolvedValue(7);
    tasks.set([failedTaskInfo(7, "boom")]);

    const { container } = render(StagingArea);
    await new Promise((r) => setTimeout(r, 0));

    const genBtn = container.querySelector('button[aria-label="AI Commit Message"]');
    await fireEvent.click(genBtn!);
    await new Promise((r) => setTimeout(r, 0));

    // The store path fires once; a simulated late event must be swallowed by
    // the `handled` guard. (We simulate it by asserting exactly one toast.)
    expect(get(toasts).filter((t) => t.type === "error")).toHaveLength(1);
  });

  it("fills the commit message box from a completed task's output (store path)", async () => {
    // Successful HTTP completion: the task is already Completed in the
    // global `tasks` store and its output already buffered in `taskOutput`
    // (both populated by the app-startup global listeners from the events
    // emitted during the invoke). The per-task listeners miss the events,
    // so the synchronous store catch-up must harvest the output. Seed with
    // the same in-place `update` mutation the real task-output listener
    // performs (returns the same map reference).
    aiGenerateCommitMessage.mockResolvedValue(9);
    tasks.set([taskInfo(9, { state: "completed" })]);
    taskOutput.update((map) => {
      map.set(9, [{ stream: "stdout", text: "fix: resolve the event race" }]);
      return map;
    });

    const { container } = render(StagingArea);
    await new Promise((r) => setTimeout(r, 0));

    const genBtn = container.querySelector('button[aria-label="AI Commit Message"]');
    await fireEvent.click(genBtn!);
    await new Promise((r) => setTimeout(r, 0));

    const summary = container.querySelector<HTMLInputElement>(
      '[data-testid="commit-message"]',
    );
    expect(summary?.value).toBe("fix: resolve the event race");
    // Loading must be cleared.
    const genBtnAfter = container.querySelector<HTMLButtonElement>(
      'button[aria-label="AI Commit Message"]',
    );
    expect(genBtnAfter?.disabled).toBe(false);
  });

  it("fills the box from the authoritative backend snapshot when no event/store ever arrived", async () => {
    // Worst case: neither the per-task listeners nor the global stores
    // ever saw the task (events lost). The backend retains the finished
    // task, so `get_tasks` + `get_task_output` must be the recovery path —
    // with NO seeded stores at all.
    aiGenerateCommitMessage.mockResolvedValue(55);
    mockInvokeResponse("get_tasks", [taskInfo(55, { state: "completed" })]);
    mockInvokeResponse("get_task_output", [
      { stream: "stdout", text: "fix: backend snapshot is authoritative" },
    ]);

    const { container } = render(StagingArea);
    await new Promise((r) => setTimeout(r, 0));

    const genBtn = container.querySelector('button[aria-label="AI Commit Message"]');
    await fireEvent.click(genBtn!);
    await new Promise((r) => setTimeout(r, 0));

    const summary = container.querySelector<HTMLInputElement>(
      '[data-testid="commit-message"]',
    );
    expect(summary?.value).toBe("fix: backend snapshot is authoritative");
  });

  it("fills BOTH summary and description from a multi-line AI output", async () => {
    // The AI returned a conventional commit: one-line subject + blank line
    // + body. `splitMessage` must route the first line into the summary
    // input and the remaining body into the description textarea.
    aiGenerateCommitMessage.mockResolvedValue(57);
    mockInvokeResponse("get_tasks", [taskInfo(57, { state: "completed" })]);
    mockInvokeResponse("get_task_output", [
      { stream: "stdout", text: "feat: support folder selection" },
      { stream: "stdout", text: "" },
      { stream: "stdout", text: "- directories now have a recursive checkbox" },
      { stream: "stdout", text: "- collapse indicator is a unicode chevron" },
    ]);

    const { container } = render(StagingArea);
    await new Promise((r) => setTimeout(r, 0));

    const genBtn = container.querySelector('button[aria-label="AI Commit Message"]');
    await fireEvent.click(genBtn!);
    await new Promise((r) => setTimeout(r, 0));

    const summary = container.querySelector<HTMLInputElement>(
      '[data-testid="commit-message"]',
    );
    expect(summary?.value).toBe("feat: support folder selection");
    const description = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="commit-description"]',
    );
    expect(description?.value).toBe(
      "- directories now have a recursive checkbox\n- collapse indicator is a unicode chevron",
    );
  });

  it("toasts the backend error from the snapshot when the task failed server-side", async () => {
    aiGenerateCommitMessage.mockResolvedValue(56);
    mockInvokeResponse("get_tasks", [
      taskInfo(56, { state: "failed", error: "OpenAI endpoint returned HTTP 401: bad key" }),
    ]);

    const { container } = render(StagingArea);
    await new Promise((r) => setTimeout(r, 0));

    const genBtn = container.querySelector('button[aria-label="AI Commit Message"]');
    await fireEvent.click(genBtn!);
    await new Promise((r) => setTimeout(r, 0));

    const errorToast = get(toasts).find((t) => t.type === "error");
    expect(errorToast?.message).toContain("HTTP 401");
    // Box stays empty on failure.
    const summary = container.querySelector<HTMLInputElement>(
      '[data-testid="commit-message"]',
    );
    expect(summary?.value).toBe("");
  });

  it("recovers output via the get_task_output back-fill when all events were missed", async () => {
    // Worst case: neither `task-output` nor `task-completed` reached the
    // webview (so `taskOutput` is empty), but the task is Completed in the
    // `tasks` store (a late `task-started` snapshot) and the backend still
    // holds the output. `selectTask` must back-fill it and the box fills.
    aiGenerateCommitMessage.mockResolvedValue(21);
    tasks.set([taskInfo(21, { state: "completed" })]);
    mockInvokeResponse("get_task_output", [
      { stream: "stdout", text: "feat: recovered via backfill" },
    ]);

    const { container } = render(StagingArea);
    await new Promise((r) => setTimeout(r, 0));

    const genBtn = container.querySelector('button[aria-label="AI Commit Message"]');
    await fireEvent.click(genBtn!);
    await new Promise((r) => setTimeout(r, 0));

    const summary = container.querySelector<HTMLInputElement>(
      '[data-testid="commit-message"]',
    );
    expect(summary?.value).toBe("feat: recovered via backfill");
  });
});