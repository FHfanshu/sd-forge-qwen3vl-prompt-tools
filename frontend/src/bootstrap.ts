import { mount, unmount } from "svelte";
import { getHostApi, handshakeWithLoom, type BridgeHandshakeRequest, type KohakuLoomBridgeApi } from "./bridge";
import Shell from "./components/Shell.svelte";
import { useUiStore } from "./stores/ui";

export const UI_READY = true as const;
let app: ReturnType<typeof mount> | null = null;
let mountTarget: HTMLElement | null = null;

export function mountSvelteUi(host: HTMLElement = document.body): ReturnType<typeof mount> | null {
  if (app) return app;
  const existing = document.querySelector<HTMLElement>("#kohaku-loom-svelte-mount");
  mountTarget = existing ?? document.createElement("div");
  mountTarget.id = "kohaku-loom-svelte-mount";
  if (!mountTarget.isConnected) host.appendChild(mountTarget);
  app = mount(Shell, { target: mountTarget });
  return app;
}

export async function unmountSvelteUi(): Promise<void> {
  if (app) {
    await unmount(app);
    app = null;
  }
  mountTarget?.remove();
  mountTarget = null;
}

export function openProfileSettings(): void {
  useUiStore.getState().setProfileSettingsOpen(true);
  useUiStore.getState().bringToFront("profiles");
}

export function closeProfileSettings(): void {
  useUiStore.getState().setProfileSettingsOpen(false);
}

export interface SvelteUiGlobal {
  readonly UI_READY: typeof UI_READY;
  readonly bridge?: KohakuLoomBridgeApi;
  mountSvelteUi: typeof mountSvelteUi;
  unmountSvelteUi: typeof unmountSvelteUi;
  openProfileSettings: typeof openProfileSettings;
  closeProfileSettings: typeof closeProfileSettings;
  handshake(request: BridgeHandshakeRequest): ReturnType<typeof handshakeWithLoom>;
  error?: string;
}

export function installRuntimeContracts(globalWindow: Window): SvelteUiGlobal {
  const api: SvelteUiGlobal = {
    UI_READY,
    get bridge() {
      return getHostApi(globalWindow.kohakuLoom) ?? undefined;
    },
    mountSvelteUi,
    unmountSvelteUi,
    openProfileSettings,
    closeProfileSettings,
    handshake(request) {
      return handshakeWithLoom(globalWindow.kohakuLoom ?? {}, request);
    },
  };
  globalWindow.KohakuLoomSvelteUi = api;
  globalWindow.dispatchEvent(new CustomEvent("kohaku-loom:svelte-ready"));
  return api;
}
