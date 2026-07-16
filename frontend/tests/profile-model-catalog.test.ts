import { beforeEach, describe, expect, it } from "vitest";
import { findModelsDevModel, modelsDevProfilePatch } from "../src/profile-model-catalog";
import { useProfileStore } from "../src/stores/profiles";

beforeEach(() => useProfileStore.getState().reset());

function profile(modelId: string) {
  return { ...useProfileStore.getState().profiles[0], modelId, endpoint: "https://api.example.test/v1" };
}

describe("models.dev profile metadata", () => {
  it("keeps effort choices separate from the reasoning capability flag", () => {
    const catalog = {
      example: {
        id: "example",
        api: "https://api.example.test/v1",
        models: {
          "reasoning-model": {
            id: "reasoning-model",
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
            limit: { context: 128_000, output: 16_000 },
            modalities: { input: ["text", "image"] },
            tool_call: true,
          },
        },
      },
    };
    const selected = profile("reasoning-model");
    const match = findModelsDevModel(catalog, selected);
    expect(match).not.toBeNull();
    const patch = modelsDevProfilePatch(selected, match!);
    expect(patch.capabilities?.reasoning).toBe(true);
    expect(patch.modelInfo?.reasoningToggle).toBe(false);
    expect(patch.modelInfo?.reasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  it("recognizes toggle-only reasoning models", () => {
    const catalog = {
      example: {
        id: "example",
        api: "https://api.example.test/v1",
        models: {
          "toggle-model": {
            id: "toggle-model",
            reasoning: true,
            reasoning_options: [{ type: "toggle" }],
            limit: {},
            modalities: { input: ["text"] },
          },
        },
      },
    };
    const selected = profile("toggle-model");
    const match = findModelsDevModel(catalog, selected);
    const patch = modelsDevProfilePatch(selected, match!);
    expect(patch.modelInfo?.reasoningToggle).toBe(true);
    expect(patch.modelInfo?.reasoningEfforts).toEqual([]);
  });
});
