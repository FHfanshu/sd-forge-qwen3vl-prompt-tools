import { z } from "zod";

export const BRIDGE_API_VERSION = 1 as const;
export const BRIDGE_VERSION = "1.0.0" as const;
export const BRIDGE_NAME = "kohaku-loom-svelte-ui" as const;
export const HOST_API_NAME = "kohaku-loom-host" as const;
const bridgeCapabilities = [
  "forge-availability",
  "prompt-target",
  "forge-state",
  "tool-execution",
  "profile-store",
  "tool-bridge-lease",
  "assistant-config",
  "session-runtime",
  "legacy-sessions",
  "locale-hints",
] as const;
export type BridgeCapability = (typeof bridgeCapabilities)[number];

export const bridgeHandshakeRequestSchema = z.object({
  client: z.string().min(1),
  apiVersion: z.number().int().nonnegative(),
});

export interface BridgeHandshakeRequest {
  client: string;
  apiVersion: number;
}

export interface BridgeHandshakeAccepted {
  ok: true;
  bridge: typeof BRIDGE_NAME;
  apiVersion: typeof BRIDGE_API_VERSION;
  version: typeof BRIDGE_VERSION;
  capabilities: readonly BridgeCapability[];
}

export interface BridgeHandshakeRejected {
  ok: false;
  bridge: typeof BRIDGE_NAME;
  apiVersion: typeof BRIDGE_API_VERSION;
  reason: "client-mismatch" | "unsupported-api-version" | "host-unavailable";
}

export type BridgeHandshakeResponse = BridgeHandshakeAccepted | BridgeHandshakeRejected;

export interface KohakuLoomHostApi {
  readonly name: typeof HOST_API_NAME;
  readonly version: typeof BRIDGE_VERSION;
  readonly apiVersion: typeof BRIDGE_API_VERSION;
  readonly capabilities: readonly BridgeCapability[];
  handshake(request: BridgeHandshakeRequest): BridgeHandshakeResponse;
  isForgeAvailable(): boolean;
  activePromptTarget(): string;
  readPrompt(target?: string): Promise<unknown>;
  captureForgeState(): unknown;
  restoreForgeState(snapshot: unknown): boolean;
  executeTool(tool: unknown, signal?: AbortSignal): Promise<unknown>;
  executeAssistantTool(tool: unknown, signal?: AbortSignal): Promise<unknown>;
  assistantConfig(routeOverride?: string): unknown;
  profileStore: KohakuLoomProfileStoreFacade;
  claimToolBridge(): Promise<unknown>;
  claimAssistantToolBridge(): Promise<unknown>;
  profileChat(profileId: string, messages: unknown[], signal?: AbortSignal): Promise<unknown>;
  listLegacySessions(limit?: number): Promise<unknown>;
  getLegacySession(sessionId: string, limit?: number): Promise<unknown>;
  readonly ktBaseUrl?: string;
  setAgentMode?(sessionId: string, mode: "normal" | "yolo"): Promise<unknown>;
  getLocaleHints(): unknown;
  subscribeLocaleHints(listener: (hints: unknown) => void): () => void;
  openSettings(): unknown;
}

export type KohakuLoomBridgeApi = KohakuLoomHostApi;

export interface KohakuLoomProfileStoreFacade {
  load(): unknown;
  current(): unknown;
  teacher(): unknown;
  session(): unknown;
  add(profile: unknown): unknown;
  duplicate(id: string): unknown;
  update(id: string, patch: unknown): unknown;
  delete(id: string): unknown;
  setActive(id: string): unknown;
  setTeacher(id: string): unknown;
  setSession(id: string): unknown;
  setNaming(id: string): unknown;
  restoreDefaults(): unknown;
  requestProjection(id?: string): unknown;
}

export interface KohakuLoomNamespace {
  hostApi?: unknown;
  svelteUiBridge?: unknown;
  forgeLocale?: unknown;
  loomForgeLocale?: unknown;
  loomActiveLocale?: unknown;
  [key: string]: unknown;
}

const capabilities = bridgeCapabilities;
const facadeCache = new WeakMap<object, KohakuLoomHostApi>();

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function assertFunction(value: unknown, name: string): void {
  if (typeof value !== "function") throw new Error(`Kohaku Loom host API missing ${name}`);
}

export function validateHostApi(value: unknown): KohakuLoomHostApi {
  if (!isObject(value)) throw new Error("Kohaku Loom host API is unavailable");
  if (value.name !== HOST_API_NAME || value.apiVersion !== BRIDGE_API_VERSION || value.version !== BRIDGE_VERSION) {
    throw new Error("Kohaku Loom host API version is unsupported");
  }
  const hostCapabilities = value.capabilities;
  if (!Array.isArray(hostCapabilities) || !capabilities.every((item) => hostCapabilities.includes(item))) {
    throw new Error("Kohaku Loom host API capabilities are incomplete");
  }
  const profileStore = value.profileStore;
  [
    "handshake",
    "isForgeAvailable",
    "activePromptTarget",
    "readPrompt",
    "captureForgeState",
    "restoreForgeState",
    "executeTool",
    "executeAssistantTool",
    "assistantConfig",
    "claimToolBridge",
    "claimAssistantToolBridge",
    "profileChat",
    "listLegacySessions",
    "getLegacySession",
    "openSettings",
    "getLocaleHints",
    "subscribeLocaleHints",
  ].forEach((name) => assertFunction(value[name], name));
  if (!isObject(profileStore)) throw new Error("Kohaku Loom host API profile store is unavailable");
  [
    "load",
    "current",
    "teacher",
    "session",
    "add",
    "duplicate",
    "update",
    "delete",
    "setActive",
    "setTeacher",
    "setSession",
    "setNaming",
    "restoreDefaults",
    "requestProjection",
  ].forEach((name) => assertFunction((profileStore as Record<string, unknown>)?.[name], `profileStore.${name}`));
  return value as unknown as KohakuLoomHostApi;
}

function createBridgeFacade(host: KohakuLoomHostApi): KohakuLoomHostApi {
  const cached = facadeCache.get(host);
  if (cached) return cached;
  const facade: KohakuLoomHostApi = {
    ...host,
    handshake(request) {
      const parsed = bridgeHandshakeRequestSchema.safeParse(request);
      if (!parsed.success || parsed.data.client !== BRIDGE_NAME) {
        return {
          ok: false,
          bridge: BRIDGE_NAME,
          apiVersion: BRIDGE_API_VERSION,
          reason: "client-mismatch",
        };
      }
      if (parsed.data.apiVersion !== BRIDGE_API_VERSION) {
        return {
          ok: false,
          bridge: BRIDGE_NAME,
          apiVersion: BRIDGE_API_VERSION,
          reason: "unsupported-api-version",
        };
      }
      return host.handshake(parsed.data);
    },
  };
  facadeCache.set(host, facade);
  return facade;
}

export function getHostApi(namespace: KohakuLoomNamespace | undefined): KohakuLoomHostApi | null {
  try {
    return createBridgeFacade(validateHostApi(namespace?.hostApi));
  } catch (_error) {
    return null;
  }
}

// Kept as a compatibility name; it validates the host and never installs a bridge.
export function installBridge(namespace: KohakuLoomNamespace): KohakuLoomHostApi {
  return createBridgeFacade(validateHostApi(namespace.hostApi));
}

export function createBridgeApi(value?: unknown): KohakuLoomHostApi {
  return createBridgeFacade(validateHostApi(value));
}

export function handshakeWithLoom(
  namespace: KohakuLoomNamespace,
  request: BridgeHandshakeRequest,
): BridgeHandshakeResponse {
  const host = getHostApi(namespace);
  if (!host) {
    return { ok: false, bridge: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION, reason: "host-unavailable" };
  }
  return host.handshake(request);
}

export { capabilities as BRIDGE_CAPABILITIES };
