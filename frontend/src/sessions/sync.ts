import type { PromptAgentMessage, PromptAgentSession } from "./schema";

const DEVICE_ID_PREFERENCE = "session-sync-device-id";

interface LocalSessionStore {
  listSessions(): Promise<PromptAgentSession[]>;
  getMessages(sessionId: string): Promise<PromptAgentMessage[]>;
  putSession(session: PromptAgentSession): Promise<void>;
  putMessage(message: PromptAgentMessage): Promise<void>;
  deleteMessages(ids: string[]): Promise<number>;
  getPreference<T>(id: string): Promise<T | undefined>;
  putPreference(id: string, value: string): Promise<void>;
}

interface SessionSnapshot {
  revision?: number;
  base_hash?: string;
  session: PromptAgentSession;
  messages: PromptAgentMessage[];
}

interface SessionSyncResponse {
  version: 1;
  sessions: Array<SessionSnapshot & { revision: number; content_hash: string }>;
  conflicts: SessionSyncConflict[];
}

export interface SessionSyncConflict {
  session_id: string;
  conflict_session_id: string;
}

export interface SessionSyncResult {
  conflicts: SessionSyncConflict[];
}

export async function synchronizePromptAgentSessions(
  store: LocalSessionStore,
  request: typeof fetch = fetch,
): Promise<SessionSyncResult> {
  const deviceId = await syncDeviceId(store);
  const sessions = await store.listSessions();
  const snapshots = await Promise.all(sessions.map(async (session): Promise<SessionSnapshot> => {
    const { syncRevision, syncHash, ...publicSession } = session;
    return {
      ...(syncRevision !== undefined ? { revision: syncRevision } : {}),
      ...(syncHash !== undefined ? { base_hash: syncHash } : {}),
      session: publicSession,
      messages: await store.getMessages(session.id),
    };
  }));
  const response = await request("/prompt-agent/api/sessions/sync", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, sessions: snapshots }),
  });
  if (!response.ok) throw new Error(`Session synchronization failed with HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  if (!isSyncResponse(payload)) throw new Error("Session synchronization returned an invalid response");
  for (const snapshot of payload.sessions) await applySnapshot(store, snapshot);
  return { conflicts: payload.conflicts };
}

async function applySnapshot(
  store: LocalSessionStore,
  snapshot: SessionSnapshot & { revision: number; content_hash: string },
): Promise<void> {
  const localMessages = await store.getMessages(snapshot.session.id);
  const remoteIds = new Set(snapshot.messages.map((message) => message.id));
  const obsolete = localMessages.filter((message) => !remoteIds.has(message.id)).map((message) => message.id);
  if (obsolete.length) await store.deleteMessages(obsolete);
  await store.putSession({ ...snapshot.session, syncRevision: snapshot.revision, syncHash: snapshot.content_hash });
  for (const message of snapshot.messages) await store.putMessage(message);
}

async function syncDeviceId(store: LocalSessionStore): Promise<string> {
  const existing = await store.getPreference<string>(DEVICE_ID_PREFERENCE);
  if (existing) return existing;
  const created = crypto.randomUUID();
  await store.putPreference(DEVICE_ID_PREFERENCE, created);
  return created;
}

function isSyncResponse(value: unknown): value is SessionSyncResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; sessions?: unknown };
  return candidate.version === 1
    && Array.isArray(candidate.sessions)
    && candidate.sessions.every(isSnapshot)
    && Array.isArray((candidate as { conflicts?: unknown }).conflicts)
    && ((candidate as { conflicts: unknown[] }).conflicts).every(isConflict);
}

function isConflict(value: unknown): value is SessionSyncConflict {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { session_id?: unknown; conflict_session_id?: unknown };
  return typeof candidate.session_id === "string" && typeof candidate.conflict_session_id === "string";
}

function isSnapshot(value: unknown): value is SessionSnapshot & { revision: number; content_hash: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { revision?: unknown; content_hash?: unknown; session?: unknown; messages?: unknown };
  if (!Number.isInteger(candidate.revision) || (candidate.revision as number) < 1) return false;
  if (typeof candidate.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(candidate.content_hash)) return false;
  if (!candidate.session || typeof candidate.session !== "object" || !Array.isArray(candidate.messages)) return false;
  const session = candidate.session as { id?: unknown };
  return typeof session.id === "string" && candidate.messages.every((message) => {
    if (!message || typeof message !== "object") return false;
    const record = message as { id?: unknown; sessionId?: unknown; message?: unknown };
    return typeof record.id === "string" && record.sessionId === session.id && !!record.message && typeof record.message === "object";
  });
}
