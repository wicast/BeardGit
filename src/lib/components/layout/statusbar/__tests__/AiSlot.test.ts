/**
 * Unit tests for `AiSlot.svelte`.
 *
 * Covers the two render branches:
 *   - With a preferred provider → `ProviderIcon` renders.
 *   - Without a preferred provider → grey dot + "AI" fallback.
 * Plus the F1 master-switch gate: the slot renders nothing while
 * `aiSurfacesVisible` is false.
 *
 * Click-navigation asserts the Settings section key ("ai") bubbles up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import type { AiProviderKind } from "$lib/types";

const mocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { writable } = require("svelte/store") as typeof import("svelte/store");
  return {
    preferredAiProvider: writable<AiProviderKind | null>(null),
    aiSurfacesVisible: writable<boolean>(true),
  };
});

vi.mock("$lib/stores/ai", () => ({
  preferredAiProvider: mocks.preferredAiProvider,
  aiSurfacesVisible: mocks.aiSurfacesVisible,
}));

import AiSlot from "../AiSlot.svelte";

beforeEach(() => {
  mocks.preferredAiProvider.set(null);
  mocks.aiSurfacesVisible.set(true);
});

afterEach(() => cleanup());

describe("AiSlot", () => {
  it("renders the fallback label when no preferred provider", async () => {
    const { getByTestId } = render(AiSlot, {
      props: { onNavigate: vi.fn() },
    });
    await tick();
    const slot = getByTestId("statusbar-ai-slot");
    expect(slot.getAttribute("data-has-provider")).toBe("false");
    expect(slot.textContent ?? "").toContain("AI");
  });

  it("renders the provider brand icon when preferred is set", async () => {
    mocks.preferredAiProvider.set("claude_code" as AiProviderKind);
    const { getByTestId, container } = render(AiSlot, {
      props: { onNavigate: vi.fn() },
    });
    await tick();
    const slot = getByTestId("statusbar-ai-slot");
    expect(slot.getAttribute("data-has-provider")).toBe("true");
    const img = container.querySelector("img.provider-icon");
    expect(img).toBeTruthy();
  });

  it("calls onNavigate('ai') when clicked", async () => {
    const onNavigate = vi.fn();
    const { getByTestId } = render(AiSlot, { props: { onNavigate } });
    await tick();
    await fireEvent.click(getByTestId("statusbar-ai-slot"));
    expect(onNavigate).toHaveBeenCalledWith("ai");
  });

  it("renders nothing when the AI master switch is off", async () => {
    mocks.aiSurfacesVisible.set(false);
    const { container, queryByTestId } = render(AiSlot, {
      props: { onNavigate: vi.fn() },
    });
    await tick();
    expect(queryByTestId("statusbar-ai-slot")).toBeNull();
    // No stray button markup either — the whole slot disappears.
    expect(container.querySelector("button.ai-slot")).toBeNull();
  });
});
