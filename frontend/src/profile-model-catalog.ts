import type { Profile, ProfilePatch } from "./contracts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
type RecordValue = Record<string, unknown>;

export interface ModelsDevMatch {
  provider: RecordValue;
  model: RecordValue;
  providerId: string;
  modelId: string;
}

function recordValue(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function aliases(value: unknown): string[] {
  const raw = String(value ?? "").trim().toLowerCase();
  const withoutEffort = raw.replace(/-(?:minimal|low|medium|high|xhigh|max)$/, "");
  const parts = raw.includes("/") ? raw.split("/").slice(1).join("/") : "";
  return Array.from(new Set([raw, withoutEffort, parts].filter(Boolean)));
}

function endpointHost(value: unknown): string {
  try {
    return new URL(String(value ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function providerScore(provider: RecordValue, profile: Profile): number {
  const endpoint = endpointHost(profile.endpoint);
  const providerApi = endpointHost(provider.api);
  const providerId = String(provider.id ?? "").toLowerCase();
  let score = endpoint && providerApi && (endpoint === providerApi || endpoint.endsWith(`.${providerApi}`)) ? 100 : 0;
  if (providerId && endpoint.includes(providerId)) score += 30;
  if (profile.protocol === "gemini-native" && providerId === "google") score += 20;
  return score;
}

export function findModelsDevModel(catalog: unknown, profile: Profile): ModelsDevMatch | null {
  const targetAliases = aliases(profile.modelId);
  const candidates: Array<ModelsDevMatch & { score: number }> = [];
  Object.entries(recordValue(catalog)).forEach(([providerKey, rawProvider]) => {
    const provider = recordValue(rawProvider);
    const providerId = String(provider.id ?? providerKey);
    Object.entries(recordValue(provider.models)).forEach(([modelKey, rawModel]) => {
      const model = recordValue(rawModel);
      const modelId = String(model.id ?? modelKey);
      if (!targetAliases.some((alias) => aliases(modelId).includes(alias))) return;
      candidates.push({ provider, model, providerId, modelId, score: providerScore(provider, profile) });
    });
  });
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] ?? null;
}

function reasoningDetails(model: RecordValue): { toggle: boolean; efforts: string[] } {
  let toggle = false;
  const efforts: string[] = [];
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  options.forEach((rawOption) => {
    const option = recordValue(rawOption);
    if (option.type === "toggle") toggle = true;
    if (option.type !== "effort") return;
    const values = Array.isArray(option.values) ? option.values : String(option.values ?? "").split(/[\s,]+/);
    efforts.push(...values.map(String));
  });
  return {
    toggle,
    efforts: Array.from(new Set(efforts.map((value) => value.toLowerCase()).filter((value) => EFFORT_ORDER.includes(value))))
      .sort((left, right) => EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right)),
  };
}

export function modelsDevProfilePatch(profile: Profile, match: ModelsDevMatch): ProfilePatch {
  const model = match.model;
  const limits = recordValue(model.limit);
  const modalities = recordValue(model.modalities);
  const inputModalities = Array.isArray(modalities.input) ? modalities.input.map(String) : [];
  const reasoning = reasoningDetails(model);
  const outputLimit = Number(limits.output) || 0;
  const patch: ProfilePatch = {
    capabilities: {
      tools: Boolean(model.tool_call),
      vision: Boolean(model.attachment) || inputModalities.includes("image"),
      reasoning: Boolean(model.reasoning) || reasoning.toggle || reasoning.efforts.length > 0,
      streaming: true,
    },
    modelInfo: {
      source: "models.dev",
      providerId: match.providerId,
      matchedModelId: match.modelId,
      contextLimit: Number(limits.context) || 0,
      outputLimit,
      temperatureSupported: model.temperature !== false,
      reasoningToggle: reasoning.toggle,
      reasoningEfforts: reasoning.efforts,
      syncedAt: new Date().toISOString(),
    },
  };
  const currentEffort = profile.parameters.reasoningEffort.toLowerCase();
  const supportsNone = reasoning.toggle || reasoning.efforts.includes("none");
  if (reasoning.efforts.length && !reasoning.efforts.includes(currentEffort) && !(currentEffort === "none" && supportsNone)) {
    patch.parameters = { reasoningEffort: reasoning.efforts.find((value) => value !== "none") ?? "none" };
  }
  if (outputLimit > 0 && profile.parameters.maxTokens > outputLimit) {
    patch.parameters = { ...patch.parameters, maxTokens: outputLimit };
  }
  return patch;
}

export async function syncProfileFromModelsDev(profile: Profile, fetchImpl: typeof fetch = fetch): Promise<ProfilePatch> {
  const response = await fetchImpl(MODELS_DEV_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`models.dev ${response.status}`);
  const match = findModelsDevModel(await response.json(), profile);
  if (!match) throw new Error(`models.dev has no exact match for ${profile.modelId}`);
  return modelsDevProfilePatch(profile, match);
}

export { MODELS_DEV_URL };
