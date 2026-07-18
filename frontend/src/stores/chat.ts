import { createStore } from "./store";
import {
  chatMessageSchema,
  queuedMessageSchema,
  type ChatAttachment,
  type ChatMessage,
  type ChatMessageInput,
  type QueuedMessage,
  type QueuedMessageInput,
} from "../contracts";
import { releaseImageAttachments, retainImageAttachments } from "../attachments";

export interface ChatStore {
  messages: ChatMessage[];
  queue: QueuedMessage[];
  activeRequestId: string | null;
  appendMessage(message: ChatMessageInput): void;
  upsertMessage(message: ChatMessageInput): void;
  updateMessage(id: string, patch: Partial<ChatMessage>): void;
  setMessages(messages: ChatMessage[]): void;
  enqueue(message: QueuedMessageInput): void;
  upsertQueue(message: QueuedMessageInput): void;
  setQueue(messages: QueuedMessageInput[]): void;
  removeQueuedMessage(id: string): void;
  clearQueue(): void;
  setAttachments(messageId: string, attachments: ChatAttachment[]): void;
  beginRequest(requestId: string): AbortSignal;
  cancelRequest(): void;
  finishRequest(requestId?: string): void;
  reset(): void;
}

let activeController: AbortController | null = null;
const QUEUE_STORAGE_KEY = "kohaku-loom:message-queue:v1";

function readQueue(): QueuedMessage[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const value: unknown = JSON.parse(storage.getItem(QUEUE_STORAGE_KEY) ?? "[]");
    const queue = Array.isArray(value) ? value.flatMap((item) => {
      const parsed = queuedMessageSchema.safeParse(item);
      if (!parsed.success) return [];
      return [{
        ...parsed.data,
        attachmentCount: Math.max(parsed.data.attachmentCount, parsed.data.attachments.length),
        attachments: [],
      }];
    }) : [];
    storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
    return queue;
  } catch {
    return [];
  }
}

function getStorage(): Storage | null {
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function"
      ? storage
      : null;
  } catch {
    return null;
  }
}

function persistQueue(queue: QueuedMessage[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue.map((message) => ({
      ...message,
      attachmentCount: Math.max(message.attachmentCount, message.attachments.length),
      attachments: [],
    }))));
  } catch {
    // Queue persistence is best effort in embedded/private contexts.
  }
}

function newerQueueMessage(current: QueuedMessage, incoming: QueuedMessage): QueuedMessage {
  if (current.sequence !== undefined && incoming.sequence !== undefined && incoming.sequence < current.sequence) return current;
  if (current.sequence === incoming.sequence && current.updatedAt !== undefined && incoming.updatedAt !== undefined && incoming.updatedAt < current.updatedAt) return current;
  return incoming;
}

function replaceOwnedAttachments(current: ChatAttachment[], next: ChatAttachment[]): void {
  retainImageAttachments(next);
  releaseImageAttachments(current);
}

export const useChatStore = createStore<ChatStore>((set, get) => ({
  messages: [],
  queue: readQueue(),
  activeRequestId: null,
  appendMessage(message) {
    const parsed = chatMessageSchema.parse(message);
    retainImageAttachments(parsed.attachments);
    set((state) => ({ messages: [...state.messages, parsed] }));
  },
  upsertMessage(message) {
    const parsed = chatMessageSchema.parse(message);
    set((state) => {
      const index = state.messages.findIndex((item) => item.id === parsed.id);
      if (index < 0) {
        retainImageAttachments(parsed.attachments);
        return { messages: [...state.messages, parsed] };
      }
      const messages = state.messages.slice();
      replaceOwnedAttachments(messages[index].attachments, parsed.attachments);
      messages[index] = parsed;
      return { messages };
    });
  },
  updateMessage(id, patch) {
    set((state) => ({ messages: state.messages.map((message) => {
      if (message.id !== id) return message;
      const next = chatMessageSchema.parse({ ...message, ...patch });
      replaceOwnedAttachments(message.attachments, next.attachments);
      return next;
    }) }));
  },
  setMessages(messages) {
    const next = messages.map((message) => chatMessageSchema.parse(message));
    replaceOwnedAttachments(get().messages.flatMap((message) => message.attachments), next.flatMap((message) => message.attachments));
    set({ messages: next });
  },
  enqueue(message) {
    set((state) => {
      const parsed = queuedMessageSchema.parse(message);
      const queue = [...state.queue, { ...parsed, attachmentCount: Math.max(parsed.attachmentCount, parsed.attachments.length), attachments: [] }];
      persistQueue(queue);
      return { queue };
    });
  },
  upsertQueue(message) {
    const value = queuedMessageSchema.parse(message);
    const parsed = { ...value, attachmentCount: Math.max(value.attachmentCount, value.attachments.length), attachments: [] };
    set((state) => {
      const index = state.queue.findIndex((item) => item.id === parsed.id);
      const queue = state.queue.slice();
      if (index < 0) queue.push(parsed);
      else queue[index] = newerQueueMessage(queue[index], parsed);
      persistQueue(queue);
      return { queue };
    });
  },
  setQueue(messages) {
    const queue = Array.from(messages.reduce((items, message) => {
      const value = queuedMessageSchema.parse(message);
      const parsed = { ...value, attachmentCount: Math.max(value.attachmentCount, value.attachments.length), attachments: [] };
      const current = items.get(parsed.id);
      items.set(parsed.id, current ? newerQueueMessage(current, parsed) : parsed);
      return items;
    }, new Map<string, QueuedMessage>()).values());
    persistQueue(queue);
    set({ queue });
  },
  removeQueuedMessage(id) {
    set((state) => {
      const queue = state.queue.filter((message) => message.id !== id);
      persistQueue(queue);
      return { queue };
    });
  },
  clearQueue() {
    persistQueue([]);
    set({ queue: [] });
  },
  setAttachments(messageId, attachments) {
    set((state) => ({
      messages: state.messages.map((message) => message.id === messageId
        ? (() => {
          const next = chatMessageSchema.parse({ ...message, attachments });
          replaceOwnedAttachments(message.attachments, next.attachments);
          return next;
        })()
        : message),
    }));
  },
  beginRequest(requestId) {
    activeController?.abort();
    activeController = new AbortController();
    set({ activeRequestId: requestId });
    return activeController.signal;
  },
  cancelRequest() {
    activeController?.abort();
    activeController = null;
    set((state) => ({
      activeRequestId: null,
      messages: state.messages.map((message) =>
        message.status === "streaming" ? { ...message, status: "cancelled" } : message,
      ),
    }));
  },
  finishRequest(requestId) {
    if (requestId && get().activeRequestId !== requestId) return;
    activeController = null;
    set({ activeRequestId: null });
  },
  reset() {
    activeController?.abort();
    activeController = null;
    releaseImageAttachments(get().messages.flatMap((message) => message.attachments));
    persistQueue([]);
    set({ messages: [], queue: [], activeRequestId: null });
  },
}));
