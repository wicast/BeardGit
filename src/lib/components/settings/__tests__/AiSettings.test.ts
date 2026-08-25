/**
 * Tests for the "Test" connection button on the OpenAI-compatible endpoint
 * config (Settings → AI). The button probes the SAVED endpoint config via
 * `ai_test_openai_endpoint` and renders the structured result inline — a
 * green result guarantees the headless actions (commit message, review, PR
 * description) can reach the endpoint.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { writable } from "svelte/store";

const aiTestOpenaiEndpoint = vi.hoisted(() => vi.fn());

vi.mock("$lib/stores/ai", () => {
  return {
    aiProviders: writable([
      { kind: "open_ai", binary_path: "<openai-compatible>", version: null, is_http: true },
    ]),
    aiProvidersDetecting: writable(false),
    preferredAiProvider: writable("open_ai"),
    aiEnabled: writable(true),
    aiSurfacesVisible: writable(true),
    loadAiEnabled: vi.fn(),
    setAiEnabled: vi.fn(),
    detectAiProviders: vi.fn(),
    setPreferredProvider: vi.fn(),
    loadPreferredProvider: vi.fn(),
  };
});
vi.mock("$lib/api/tauri", () => ({
  aiBackgroundGetSettings: vi.fn().mockResolvedValue({
    worktree_root: null,
    concurrency_cap: 3,
    auto_accept_permissions: false,
  }),
  aiBackgroundSetSettings: vi.fn(),
  getOpenaiConfig: vi.fn().mockResolvedValue({
    base_url: "http://localhost:11434/v1",
    api_key: "",
    model: "llama3.1",
  }),
  setOpenaiConfig: vi.fn(),
  aiTestOpenaiEndpoint,
}));

import AiSettings from "../AiSettings.svelte";

afterEach(() => cleanup());

describe("AiSettings OpenAI endpoint test button", () => {
  it("renders a Test button next to Save", async () => {
    const { container } = render(AiSettings);
    await new Promise((r) => setTimeout(r, 0));
    const testBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="openai-test"]',
    );
    expect(testBtn).toBeTruthy();
    expect(testBtn?.textContent?.trim()).toBe("Test");
  });

  it("shows success text with the HTTP status on a green result", async () => {
    aiTestOpenaiEndpoint.mockResolvedValue({
      ok: true,
      status: 200,
      message: "ok",
      url: "http://localhost:11434/v1/chat/completions",
      model: "llama3.1",
    });
    const { container } = render(AiSettings);
    await new Promise((r) => setTimeout(r, 0));

    const testBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="openai-test"]',
    );
    await fireEvent.click(testBtn!);

    await waitFor(() => {
      const result = container.querySelector('[data-testid="openai-test-result"]');
      expect(result).toBeTruthy();
      expect(result?.textContent).toContain("Connection OK (HTTP 200)");
      expect(result?.textContent).toContain("http://localhost:11434/v1/chat/completions");
    });
    expect(aiTestOpenaiEndpoint).toHaveBeenCalledTimes(1);
  });

  it("shows the backend error message verbatim on a failed result", async () => {
    aiTestOpenaiEndpoint.mockResolvedValue({
      ok: false,
      status: 0,
      message: "OpenAI endpoint unreachable (http://localhost:11434/v1/chat/completions): boom",
      url: "http://localhost:11434/v1/chat/completions",
      model: null,
    });
    const { container } = render(AiSettings);
    await new Promise((r) => setTimeout(r, 0));

    const testBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="openai-test"]',
    );
    await fireEvent.click(testBtn!);

    await waitFor(() => {
      const result = container.querySelector('[data-testid="openai-test-result"]');
      expect(result).toBeTruthy();
      expect(result?.textContent).toContain("OpenAI endpoint unreachable");
    });
  });

  it("handles an invoke rejection by rendering it as a failed result", async () => {
    aiTestOpenaiEndpoint.mockRejectedValue(new Error("AI is disabled"));
    const { container } = render(AiSettings);
    await new Promise((r) => setTimeout(r, 0));

    const testBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="openai-test"]',
    );
    await fireEvent.click(testBtn!);

    await waitFor(() => {
      const result = container.querySelector('[data-testid="openai-test-result"]');
      expect(result?.textContent).toContain("Error: AI is disabled");
    });
  });
});