import { describe, expect, it } from "vitest";
import {
  BRIDGE_API_VERSION,
  BRIDGE_CAPABILITIES,
  BRIDGE_NAME,
  HOST_API_NAME,
  handshakeWithLoom,
  installBridge,
  validateHostApi,
} from "../src/bridge";

function hostApi() {
  const profileStore = Object.fromEntries([
    "load", "current", "teacher", "session", "add", "duplicate", "update", "delete",
    "setActive", "setTeacher", "setSession", "setNaming", "restoreDefaults", "requestProjection",
  ].map((name) => [name, vi.fn()]));
  return {
    name: HOST_API_NAME,
    version: "1.0.0",
    apiVersion: BRIDGE_API_VERSION,
    capabilities: [...BRIDGE_CAPABILITIES],
    handshake: vi.fn((request: { client: string; apiVersion: number }) => ({
      ok: true as const,
      bridge: BRIDGE_NAME,
      apiVersion: BRIDGE_API_VERSION,
      version: "1.0.0" as const,
      capabilities: BRIDGE_CAPABILITIES,
      request,
    })),
    isForgeAvailable: vi.fn(),
    activePromptTarget: vi.fn(),
    readPrompt: vi.fn(),
    captureForgeState: vi.fn(),
    restoreForgeState: vi.fn(),
    executeTool: vi.fn(),
    executeAssistantTool: vi.fn(),
    assistantConfig: vi.fn(),
    profileStore,
    claimToolBridge: vi.fn(),
    claimAssistantToolBridge: vi.fn(),
    profileChat: vi.fn(),
    listLegacySessions: vi.fn(),
    getLegacySession: vi.fn(),
    openSettings: vi.fn(),
    getLocaleHints: vi.fn(),
    subscribeLocaleHints: vi.fn(),
  };
}

describe("Kohaku Loom bridge handshake", () => {
  it("accepts the host-owned API without replacing legacy keys", () => {
    const legacy = vi.fn();
    const host = hostApi();
    const namespace = { hostApi: host, legacy, existing: "preserved" };
    const bridge = installBridge(namespace);
    const result = bridge.handshake({ client: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION });

    expect(result).toMatchObject({ ok: true, bridge: BRIDGE_NAME, apiVersion: 1, version: "1.0.0" });
    expect(namespace.legacy).toBe(legacy);
    expect(namespace.existing).toBe("preserved");
    expect(namespace).not.toHaveProperty("svelteUiBridge");
    expect(installBridge(namespace)).toBe(bridge);
  });

  it("rejects a missing or incompatible host instead of installing a fake bridge", () => {
    expect(() => installBridge({})).toThrow(/host API/);
    expect(handshakeWithLoom({}, { client: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION })).toMatchObject({
      ok: false,
      reason: "host-unavailable",
    });
    expect(() => validateHostApi({ ...hostApi(), apiVersion: 99 })).toThrow(/version/);
  });

  it("rejects mismatched clients and API versions through the host handshake", () => {
    const bridge = installBridge({ hostApi: hostApi() });
    expect(bridge.handshake({ client: "other-ui" as typeof BRIDGE_NAME, apiVersion: 1 })).toMatchObject({
      ok: false,
      reason: "client-mismatch",
    });
    expect(bridge.handshake({ client: BRIDGE_NAME, apiVersion: 99 })).toMatchObject({
      ok: false,
      reason: "unsupported-api-version",
    });
  });
});
