import type { ChatMessage, QueuedMessage } from "./contracts";
import { chatMessageSchema } from "./contracts";
import { asRecord, mapQueuedMessage, textFromContent } from "./runtime-formatters";

type RawRecord = Record<string, any>;

export interface BridgeLease {
  owned: boolean;
  bridgeId: string;
  pendingRequests: RawRecord[];
}

export function parseBridgeLease(value: unknown): BridgeLease | null {
  const record = asRecord(value);
  if (typeof record.owned !== "boolean" || typeof record.bridge_id !== "string" || !record.bridge_id.trim()) return null;
  const pendingRequests = Array.isArray(record.pending_requests)
    ? record.pending_requests.filter((item): item is RawRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  return { owned: record.owned, bridgeId: record.bridge_id.trim(), pendingRequests };
}

export function queuedMessageFromConversation(conversation: RawRecord | null, id: string): QueuedMessage | null {
  if (!conversation || !Array.isArray(conversation.queue)) return null;
  return conversation.queue.map(mapQueuedMessage).find((message) => message.id === id) ?? null;
}

export function setBoundedMapValue<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

export function mapLegacyMessages(data: unknown): ChatMessage[] {
  const messages: ChatMessage[] = [];
  (Array.isArray(asRecord(data).events) ? asRecord(data).events : []).forEach((event: unknown, index: number) => {
    const value = asRecord(event);
    const message = asRecord(value.message ?? value.payload ?? value);
    const eventType = String(value.event_type ?? message.role ?? "");
    const attachments = message.image ? [{ id: `legacy-image-${index}`, name: String(message.filename ?? "reference image"), dataUrl: String(message.image) }] : [];
    if (eventType === "tool_result") {
      const result = asRecord(message.result);
      const failed = result.ok === false || Boolean(result.error);
      messages.push(chatMessageSchema.parse({
        id: `legacy-${index}`,
        role: "tool",
        content: "",
        status: failed ? "error" : "complete",
        tool: {
          name: String(message.tool ?? "Tool"),
          status: failed ? "error" : "complete",
          detail: failed ? "Tool failed in this archived session" : "Completed in this archived session",
        },
        attachments,
      }));
      return;
    }
    const content = textFromContent(message.content).trim();
    if (!content) return;
    const role = eventType.includes("user") ? "user" : eventType.includes("error") ? "error" : "assistant";
    messages.push(chatMessageSchema.parse({ id: `legacy-${index}`, role, content, status: role === "error" ? "error" : "complete", attachments }));
  });
  return messages;
}
