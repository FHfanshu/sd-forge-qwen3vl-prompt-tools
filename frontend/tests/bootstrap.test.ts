import { describe, expect, it, vi } from "vitest";
import { BRIDGE_API_VERSION, BRIDGE_NAME } from "../src/bridge";
import { installRuntimeContracts } from "../src/bootstrap";

describe("Svelte runtime bootstrap", () => {
  it("installs the Svelte contract before the host API exists", () => {
    delete window.kohakuLoom;
    const ready = vi.fn();
    window.addEventListener("kohaku-loom:svelte-ready", ready, { once: true });

    const api = installRuntimeContracts(window);

    expect(api.UI_READY).toBe(true);
    expect(api.bridge).toBeUndefined();
    expect(api.handshake({ client: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION })).toMatchObject({ ok: false, reason: "host-unavailable" });
    expect(window.KohakuLoomSvelteUi).toBe(api);
    expect(ready).toHaveBeenCalledOnce();
  });
});
