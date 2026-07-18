import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProfileSettings from "../src/components/ProfileSettings.svelte";
import { BRIDGE_API_VERSION, BRIDGE_CAPABILITIES, BRIDGE_NAME, HOST_API_NAME } from "../src/bridge";
import { useI18nStore } from "../src/stores/i18n";
import { useProfileStore } from "../src/stores/profiles";
import { useUiStore } from "../src/stores/ui";

beforeEach(() => {
  document.body.removeAttribute("style");
  useProfileStore.getState().reset();
  useUiStore.getState().reset();
  useI18nStore.getState().clearManualLocale();
  useI18nStore.getState().reset();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  vi.useRealTimers();
  delete window.kohakuLoom;
});

function installHost(profileChat: (profileId: string, messages: unknown[], signal?: AbortSignal, timeout?: number) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const profileStore = Object.fromEntries([
    "load", "current", "teacher", "session", "add", "duplicate", "update", "delete",
    "setActive", "setTeacher", "setSession", "setNaming", "restoreDefaults", "requestProjection",
  ].map((name) => [name, vi.fn()]));
  const syncProfiles = vi.fn(() => Promise.resolve({}));
  window.kohakuLoom = { hostApi: {
    name: HOST_API_NAME,
    version: "1.0.0",
    apiVersion: BRIDGE_API_VERSION,
    capabilities: [...BRIDGE_CAPABILITIES],
    handshake: () => ({ ok: true, bridge: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION, version: "1.0.0", capabilities: BRIDGE_CAPABILITIES }),
    isForgeAvailable: vi.fn(), activePromptTarget: vi.fn(), readPrompt: vi.fn(), captureForgeState: vi.fn(), restoreForgeState: vi.fn(),
    executeTool: vi.fn(), executeAssistantTool: vi.fn(), assistantConfig: vi.fn(), profileStore,
    claimToolBridge: vi.fn(), releaseToolBridge: vi.fn(), claimAssistantToolBridge: vi.fn(), releaseAssistantToolBridge: vi.fn(),
    syncProfiles, profileChat, listLegacySessions: vi.fn(), getLegacySession: vi.fn(), openSettings: vi.fn(),
    getLocaleHints: vi.fn(), subscribeLocaleHints: vi.fn(),
  } };
  return syncProfiles;
}

describe("Svelte profile settings", () => {
  it("shows the flat model summary and direct settings tabs", () => {
    render(ProfileSettings, { open: true, onclose: () => undefined });
    expect(screen.getByRole("dialog", { name: "Model profiles" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
    ["Model", "Connection", "Generation", "Routes"].forEach((name) => expect(screen.getByRole("tab", { name })).toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: "Local" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Interface" })).not.toBeInTheDocument();
  });

  it("keeps touch tablets in a floating, resizable profile window", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1180 });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });

    render(ProfileSettings, { open: true, onclose: () => undefined });

    const dialog = screen.getByRole("dialog", { name: "Model profiles" });
    expect(dialog).toHaveStyle({ width: "700px", height: "600px" });
    expect(screen.getByRole("button", { name: "Resize profile window" })).toBeInTheDocument();
  });

  it("keeps narrow phones full-screen without a resize handle", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });

    render(ProfileSettings, { open: true, onclose: () => undefined });

    const dialog = screen.getByRole("dialog", { name: "Model profiles" });
    expect(dialog).toHaveStyle({ left: "0px", top: "0px", width: "390px", height: "844px" });
    expect(screen.queryByRole("button", { name: "Resize profile window" })).not.toBeInTheDocument();
  });

  it("reports the resolved connection route and forwards a bounded timeout", async () => {
    const profileChat = vi.fn(async () => ({ text: "OK", transport: "system/environment proxy http://127.0.0.1:7890" }));
    installHost(profileChat);
    render(ProfileSettings, { open: true, onclose: () => undefined });

    await fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Connection successful"));
    expect(screen.getByRole("status")).toHaveTextContent("system/environment proxy http://127.0.0.1:7890");
    expect(profileChat).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.any(AbortSignal), 30);
  });

  it("recovers the connection-test controls after the client deadline", async () => {
    vi.useFakeTimers();
    useProfileStore.getState().updateProfile(useProfileStore.getState().selectedProfileId, { parameters: { timeout: 1 } });
    installHost((_profileId, _messages, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    render(ProfileSettings, { open: true, onclose: () => undefined });

    await fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
    await vi.advanceTimersByTimeAsync(3000);

    expect(screen.getByRole("status")).toHaveTextContent("Connection test timed out");
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
  });

  it("puts the enabled switch in the model summary", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    const toggle = screen.getByRole("button", { name: "Toggle model availability" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(useProfileStore.getState().profiles.find((profile) => profile.id === useProfileStore.getState().selectedProfileId)?.enabled).toBe(false);
  });

  it("coalesces rapid profile edits into one host sync", async () => {
    vi.useFakeTimers();
    const syncProfiles = installHost(async () => ({ text: "OK" }));
    useProfileStore.getState().reload();
    const profileId = useProfileStore.getState().selectedProfileId;

    useProfileStore.getState().updateProfile(profileId, { displayName: "A" });
    useProfileStore.getState().updateProfile(profileId, { displayName: "AB" });
    useProfileStore.getState().updateProfile(profileId, { displayName: "ABC" });
    expect(syncProfiles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(syncProfiles).toHaveBeenCalledOnce();
  });

  it("switches language from the shadcn dropdown", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("button", { name: "Language" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "简体中文" }));
    expect(useI18nStore.getState().manualLocale).toBe("zh-CN");
  });

  it("shows local runtime controls without the irrelevant connection tab", () => {
    const local = useProfileStore.getState().profiles.find((profile) => profile.runtime === "llama-once");
    expect(local).toBeDefined();
    useProfileStore.getState().selectProfile(local!.id);
    render(ProfileSettings, { open: true, onclose: () => undefined });
    expect(screen.getByRole("tab", { name: "Local" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Connection" })).not.toBeInTheDocument();
  });

  it("requires alert-dialog confirmation before deletion", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    const count = useProfileStore.getState().profiles.length;
    const profile = useProfileStore.getState().profiles[0];
    await user.click(screen.getByRole("button", { name: `${profile.displayName} actions` }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(useProfileStore.getState().profiles).toHaveLength(count);
    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(useProfileStore.getState().profiles).toHaveLength(count - 1);
  });

  it("exposes active, teacher, session, and naming route controls", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("tab", { name: "Routes" }));
    expect(screen.getByRole("combobox", { name: /Active profile/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Teacher profile/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Session model/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Naming model/ })).toBeInTheDocument();
  });
});
