import { describe, expect, vi } from "vitest";
import { synchronizePromptAgentSessions } from "../src/sessions/sync";
import type { PromptAgentMessage, PromptAgentSession } from "../src/sessions/schema";
import { acceptanceTest } from "./acceptance";

const contentHash = "a".repeat(64);

const session = (id = "session-a"): PromptAgentSession => ({
  id,
  title: "hello",
  createdAt: 100,
  updatedAt: 200,
  profileId: "local-endpoint",
  providerId: "llama-cpp",
  modelId: "local-model",
  reasoningLevel: "off",
  systemPrompt: "",
  schemaVersion: 1,
});

const message = (sessionId = "session-a"): PromptAgentMessage => ({
  id: `${sessionId}:user:100`,
  sessionId,
  message: { role: "user", content: "hello", timestamp: 100 },
  status: "complete",
  createdAt: 100,
  updatedAt: 200,
});

function store(initialSessions: PromptAgentSession[] = [], initialMessages: PromptAgentMessage[] = []) {
  const sessions = new Map(initialSessions.map((item) => [item.id, item]));
  const messages = new Map(initialMessages.map((item) => [item.id, item]));
  const preferences = new Map<string, string>();
  return {
    sessions,
    messages,
    preferences,
    listSessions: async () => [...sessions.values()],
    getMessages: async (sessionId: string) => [...messages.values()].filter((item) => item.sessionId === sessionId),
    putSession: async (item: PromptAgentSession) => { sessions.set(item.id, item); },
    putMessage: async (item: PromptAgentMessage) => { messages.set(item.id, item); },
    deleteMessages: async (ids: string[]) => {
      let count = 0;
      ids.forEach((id) => { if (messages.delete(id)) count += 1; });
      return count;
    },
    getPreference: async <T>(id: string) => preferences.get(id) as T | undefined,
    putPreference: async (id: string, value: string) => { preferences.set(id, value); },
  };
}

describe("cross-browser session sync", () => {
  acceptanceTest("SESSION-SYNC-001@1", "cross-device", "uploads local snapshots and persists the returned revision", async () => {
    const local = store([session()], [message()]);
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.sessions[0].session.id).toBe("session-a");
      expect(body.sessions[0].messages).toHaveLength(1);
      return new Response(JSON.stringify({
        version: 1,
        conflicts: [],
        sessions: [{ revision: 3, content_hash: contentHash, session: body.sessions[0].session, messages: body.sessions[0].messages }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await synchronizePromptAgentSessions(local, request as typeof fetch);

    expect(local.sessions.get("session-a")?.syncRevision).toBe(3);
    expect(local.sessions.get("session-a")?.syncHash).toBe(contentHash);
    expect(local.preferences.get("session-sync-device-id")).toBeTruthy();
  });

  acceptanceTest("SESSION-SYNC-001@1", "conflict", "hydrates an empty browser and reports a conflict fork", async () => {
    const local = store();
    const remoteSession = session("session-conflict");
    const remoteMessage = message("session-conflict");
    const request = vi.fn(async () => new Response(JSON.stringify({
      version: 1,
      conflicts: [{ session_id: "session-a", conflict_session_id: "session-conflict" }],
      sessions: [{ revision: 1, content_hash: contentHash, session: remoteSession, messages: [remoteMessage] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await synchronizePromptAgentSessions(local, request as typeof fetch);

    expect(local.sessions.get("session-conflict")?.syncRevision).toBe(1);
    expect(local.messages.get("session-conflict:user:100")).toEqual(remoteMessage);
    expect(result.conflicts[0].conflict_session_id).toBe("session-conflict");
  });

  acceptanceTest("SESSION-SYNC-001@1", "offline-cache", "does not replace local data when the server response is invalid", async () => {
    const local = store([session()], [message()]);
    const request = vi.fn(async () => new Response(JSON.stringify({ version: 1, sessions: [] }), { status: 200 }));

    await expect(synchronizePromptAgentSessions(local, request as typeof fetch)).rejects.toThrow("invalid response");
    expect(local.sessions.get("session-a")?.title).toBe("hello");
  });
});
