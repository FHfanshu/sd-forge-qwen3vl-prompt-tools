import type { RuntimeSession } from "./contracts";
import { KTClient } from "./kt/client";
import { KTHttpError } from "./kt/retry";

type RawRecord = Record<string, any>;

export async function openSessionWithConflictRecovery(
  client: KTClient,
  body: RawRecord,
): Promise<{ session: RuntimeSession; runtime?: RawRecord; adopted: boolean }> {
  try {
    const response = await client.request<{ session: RuntimeSession }>("/sessions/open", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { session: response.session, adopted: false };
  } catch (error) {
    if (!(error instanceof KTHttpError) || error.status !== 409) throw error;
    const runtime = await client.request<RawRecord>("/runtime");
    const active = runtime.active_session && typeof runtime.active_session === "object" ? runtime.active_session as RawRecord : {};
    const activeId = String(active.session_id ?? "");
    if (body.resume && body.session_id && activeId === body.session_id) {
      return { session: { ...active, session_id: activeId } as RuntimeSession, runtime, adopted: true };
    }
    if (!activeId) throw error;
    await client.request("/sessions/close", { method: "POST" });
    const response = await client.request<{ session: RuntimeSession }>("/sessions/open", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { session: response.session, adopted: false };
  }
}
