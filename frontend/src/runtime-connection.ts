import { getHostApi, waitForHostApi, type KohakuLoomNamespace } from "./bridge";
import { LoomRuntimeController } from "./runtime-controller";

export function createRuntimeController(namespace?: KohakuLoomNamespace): LoomRuntimeController | null {
  const host = getHostApi(namespace ?? (typeof window === "undefined" ? undefined : window.kohakuLoom));
  return host ? new LoomRuntimeController(host) : null;
}

export async function connectRuntimeController(
  namespace: () => KohakuLoomNamespace | undefined = () => typeof window === "undefined" ? undefined : window.kohakuLoom,
  signal?: AbortSignal,
): Promise<LoomRuntimeController> {
  const host = getHostApi(namespace()) ?? await waitForHostApi(namespace, { signal, timeoutMs: 15_000, intervalMs: 100 });
  return new LoomRuntimeController(host);
}
