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
  setQueue(messages: QueuedMessage[]): void;
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
    return Array.isArray(value) ? value.flatMap((item) => {
      const parsed = queuedMessageSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }) : [];
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
    storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Queue persistence is best effort in embedded/private contexts.
  }
}

export const useChatStore = createStore<ChatStore>((set, get) => ({
  messages: [],
  queue: readQueue(),
  activeRequestId: null,
  appendMessage(message) {
    set((state) => ({ messages: [...state.messages, chatMessageSchema.parse(message)] }));
  },
  upsertMessage(message) {
    const parsed = chatMessageSchema.parse(message);
    set((state) => {
      const index = state.messages.findIndex((item) => item.id === parsed.id);
      if (index < 0) return { messages: [...state.messages, parsed] };
      const messages = state.messages.slice();
      messages[index] = parsed;
      return { messages };
    });
  },
  updateMessage(id, patch) {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? chatMessageSchema.parse({ ...message, ...patch }) : message,
      ),
    }));
  },
  setMessages(messages) {
    set({ messages: messages.map((message) => chatMessageSchema.parse(message)) });
  },
  enqueue(message) {
    set((state) => {
      const queue = [...state.queue, queuedMessageSchema.parse(message)];
      persistQueue(queue);
      return { queue };
    });
  },
  upsertQueue(message) {
    const parsed = queuedMessageSchema.parse(message);
    set((state) => {
      const index = state.queue.findIndex((item) => item.id === parsed.id);
      const queue = state.queue.slice();
      if (index < 0) queue.push(parsed);
      else queue[index] = parsed;
      persistQueue(queue);
      return { queue };
    });
  },
  setQueue(messages) {
    const queue = messages.map((message) => queuedMessageSchema.parse(message));
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
        ? chatMessageSchema.parse({ ...message, attachments })
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
    persistQueue([]);
    set({ messages: [], queue: [], activeRequestId: null });
  },
}));
