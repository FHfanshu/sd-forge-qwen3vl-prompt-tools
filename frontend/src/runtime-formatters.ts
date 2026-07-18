import type {
  BranchMetadata,
  BranchTurn,
  ChatAttachment,
  ChatMessage,
  HistoryRow,
  Profile,
  QueuedMessage,
  SendMessageInput,
  WireAttachment,
} from "./contracts";
import { attachmentSchema, chatMessageSchema, queuedMessageSchema } from "./contracts";
import { normalizeProfile } from "./profile-adapter";

export type RawRecord = Record<string, any>;

export function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.filter((part) => asRecord(part).type === "text").map((part) => String(asRecord(part).text ?? "")).join("\n");
}

function attachmentsFromContent(content: unknown): ChatAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index) => {
    const value = asRecord(part);
    const image = asRecord(value.image_url);
    if (value.type !== "image_url" || typeof image.url !== "string") return [];
    return [{
      id: `server-attachment-${index}-${String(image.url).slice(-12)}`,
      name: String(asRecord(value.meta).source_name ?? "reference image"),
      dataUrl: image.url,
      mimeType: asRecord(value.meta).source_mime ? String(asRecord(value.meta).source_mime) : undefined,
      size: Number.isFinite(Number(asRecord(value.meta).source_size)) ? Number(asRecord(value.meta).source_size) : undefined,
    }];
  });
}

function attachmentsFromMessage(content: unknown, rawAttachments: unknown): ChatAttachment[] {
  const inline = attachmentsFromContent(content);
  if (inline.length || !Array.isArray(rawAttachments)) return inline;
  return rawAttachments.flatMap((item, index) => {
    const parsed = attachmentSchema.safeParse(item);
    if (parsed.success) return [parsed.data];
    const value = asRecord(item);
    const dataUrl = String(value.dataUrl ?? value.data_url ?? "");
    if (!dataUrl) return [];
    return [{
      id: String(value.id ?? `server-attachment-${index}`),
      name: String(value.name ?? "reference image"),
      dataUrl,
      mimeType: value.mimeType ? String(value.mimeType) : undefined,
      size: Number.isFinite(Number(value.size)) ? Number(value.size) : undefined,
    }];
  });
}

export function usageFrom(value: unknown): ChatMessage["usage"] {
  const source = asRecord(asRecord(value).usage ?? value);
  const number = (candidate: unknown): number | undefined => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const inputTokens = number(source.input_tokens ?? source.prompt_tokens);
  const outputTokens = number(source.output_tokens ?? source.completion_tokens);
  const totalTokens = number(source.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const latencyMs = number(source.latency_ms ?? source.latencyMs);
  const durationSeconds = number(source.duration_s);
  const resolvedLatency = latencyMs ?? (durationSeconds === undefined ? undefined : Math.round(durationSeconds * 1000));
  if ([inputTokens, outputTokens, totalTokens, resolvedLatency].every((item) => item === undefined)) return undefined;
  return { inputTokens, outputTokens, totalTokens, latencyMs: resolvedLatency };
}

function createdAtMilliseconds(rawValue: unknown): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) return Date.now();
  return Math.trunc(value < 10_000_000_000 ? value * 1000 : value);
}

function branchForTurn(branches: BranchMetadata | null, turnIndex: number, role: ChatMessage["role"]): { index: number; count: number } {
  const turn = branches?.turns?.find((item) => item.turnIndex === turnIndex);
  if (!turn) return { index: 0, count: 1 };
  const selected = turn.selectedBranchId ?? turn.latestBranch ?? turn.branches[0] ?? 0;
  const groups = turn.userGroups ?? [];
  if (role === "user" && groups.length) {
    return { index: Math.max(0, turn.selectedUserGroupIndex ?? 0), count: groups.length };
  }
  const selectedGroup = groups.find((group) => group.branches.includes(selected));
  const available = role === "assistant" && selectedGroup ? selectedGroup.branches : turn.branches;
  return { index: Math.max(0, available.indexOf(selected)), count: Math.max(1, available.length) };
}

export function normalizeBranchMetadata(value: unknown): BranchMetadata | null {
  const raw = asRecord(value);
  if (!Object.keys(raw).length) return null;
  const numberMap = (candidate: unknown): Record<string, number> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
    return Object.fromEntries(Object.entries(candidate as RawRecord).flatMap(([key, item]) => {
      const parsed = Number(item);
      return Number.isFinite(parsed) ? [[key, parsed]] : [];
    }));
  };
  const turns: BranchTurn[] = Array.isArray(raw.turns) ? raw.turns.flatMap((item) => {
    const turn = asRecord(item);
    const turnIndex = Number(turn.turnIndex ?? turn.turn_index);
    const branches = Array.isArray(turn.branches) ? turn.branches.map(Number).filter(Number.isFinite) : [];
    if (!Number.isInteger(turnIndex) || !branches.length) return [];
    const statuses = asRecord(turn.branchStatuses ?? turn.branch_statuses);
    const rawGroups = Array.isArray(turn.userGroups ?? turn.user_groups) ? turn.userGroups ?? turn.user_groups : [];
    const userGroups = rawGroups.flatMap((item: unknown) => {
      const group = asRecord(item);
      const groupBranches = Array.isArray(group.branches) ? group.branches.map(Number).filter(Number.isFinite) : [];
      return groupBranches.length ? [{ content: String(group.content ?? ""), branches: groupBranches }] : [];
    });
    return [{
      turnIndex,
      branches,
      branchCount: Math.max(1, Number(turn.branchCount ?? turn.branch_count ?? branches.length)),
      latestBranch: Number.isFinite(Number(turn.latestBranch ?? turn.latest_branch)) ? Number(turn.latestBranch ?? turn.latest_branch) : undefined,
      selectedBranchId: Number.isFinite(Number(turn.selectedBranchId ?? turn.selected_branch_id)) ? Number(turn.selectedBranchId ?? turn.selected_branch_id) : undefined,
      branchStatuses: Object.fromEntries(Object.entries(statuses).map(([key, status]) => [key, String(status)])),
      userGroups,
      selectedUserGroupIndex: Number.isFinite(Number(turn.selectedUserGroupIndex ?? turn.selected_user_group_index))
        ? Number(turn.selectedUserGroupIndex ?? turn.selected_user_group_index)
        : undefined,
    }];
  }) : [];
  return {
    ...raw,
    session_id: raw.session_id ? String(raw.session_id) : undefined,
    branch_view: numberMap(raw.branch_view),
    selected_branch_ids: numberMap(raw.selected_branch_ids),
    branch_counts: numberMap(raw.branch_counts),
    latest_branch_ids: numberMap(raw.latest_branch_ids),
    branch_statuses: raw.branch_statuses,
    turns,
    final_turn_index: raw.final_turn_index === null || raw.final_turn_index === undefined ? raw.final_turn_index as number | null | undefined : Number(raw.final_turn_index),
  };
}

export function mapConversationMessage(rawValue: unknown, index: number, branches: BranchMetadata | null, turnIndex: number): ChatMessage {
  const raw = asRecord(rawValue);
  const roleValue = String(raw.role ?? raw.event_type ?? "assistant").toLowerCase();
  const role = roleValue === "user" ? "user" : roleValue === "tool" ? "tool" : roleValue === "system" ? "system" : roleValue === "error" ? "error" : "assistant";
  const messageTurnIndex = Number(raw.turn_index ?? raw.turnIndex);
  const resolvedTurnIndex = Number.isInteger(messageTurnIndex) ? messageTurnIndex : turnIndex;
  const branch = role === "assistant" || role === "user" ? branchForTurn(branches, resolvedTurnIndex, role) : { index: 0, count: 1 };
  const rawStatus = String(raw.status ?? raw.state ?? "complete").toLowerCase();
  const status = rawStatus === "streaming" ? "streaming" : rawStatus === "cancelled" || rawStatus === "interrupted" ? "cancelled" : rawStatus === "error" || rawStatus === "failed" ? "error" : "complete";
  const tool = raw.tool || raw.tool_name ? {
    name: String(raw.tool?.name ?? raw.tool_name ?? raw.name ?? "tool"),
    status: rawStatus === "error" || rawStatus === "failed" ? "error" : "complete",
    detail: raw.tool?.detail ? String(raw.tool.detail) : undefined,
  } : undefined;
  return chatMessageSchema.parse({
    id: String(raw.id ?? raw.message_id ?? `server-message-${index}`),
    role,
    content: textFromContent(raw.content ?? raw.text ?? ""),
    status,
    reasoning: raw.reasoning ? String(raw.reasoning) : undefined,
    usage: usageFrom(raw.usage),
    tool,
    attachments: attachmentsFromMessage(raw.content, raw.attachments),
    branchIndex: branch.index,
    branchCount: branch.count,
    branchTurnIndex: role === "assistant" || role === "user" ? resolvedTurnIndex : undefined,
    createdAt: createdAtMilliseconds(raw.created_at ?? raw.createdAt),
  });
}

export function mapQueuedMessage(rawValue: unknown): QueuedMessage {
  const raw = asRecord(rawValue);
  const attachments = attachmentsFromMessage(raw.content, raw.attachments);
  return queuedMessageSchema.parse({
    id: String(raw.message_id ?? raw.id),
    text: String(raw.display_content ?? raw.text ?? textFromContent(raw.content ?? "")),
    attachments: [],
    attachmentCount: Math.max(Number(raw.attachmentCount ?? raw.attachment_count ?? 0) || 0, attachments.length),
    state: raw.state,
    kind: raw.kind,
    error: raw.error ? String(raw.error) : undefined,
    turnId: raw.turn_id || raw.turnId ? String(raw.turn_id ?? raw.turnId) : undefined,
    sequence: Number.isFinite(Number(raw.sequence)) ? Number(raw.sequence) : undefined,
    updatedAt: Number.isFinite(Number(raw.updated_at ?? raw.updatedAt)) ? Number(raw.updated_at ?? raw.updatedAt) : undefined,
    createdAt: createdAtMilliseconds(raw.created_at ?? raw.createdAt),
  });
}

export function mapProfile(rawValue: unknown): Profile {
  return normalizeProfile(rawValue);
}

export function mapHistory(rawValue: unknown, source: "KT" | "legacy"): HistoryRow {
  const raw = asRecord(rawValue);
  const id = String(raw.session_id ?? raw.id);
  const modified = raw.modified_at ?? raw.updated_at ?? raw.created_at;
  const timestamp = typeof modified === "number" ? new Date(modified * (modified < 10_000_000_000 ? 1000 : 1)).toLocaleString() : String(modified ?? "");
  const suppliedTitle = String(raw.title ?? raw.name ?? "").trim();
  const title = suppliedTitle || (source === "legacy" ? "Legacy session" : "Untitled session");
  const preview = String(raw.preview ?? raw.description ?? raw.summary ?? "");
  return { id, source, title, preview, updatedAt: timestamp || "", messageCount: Math.max(0, Number(raw.message_count ?? raw.messageCount ?? 0) || 0) };
}

export function contentForMessage(input: Pick<SendMessageInput, "text"> & { attachments: WireAttachment[] }): string | RawRecord[] {
  const parts: RawRecord[] = [];
  if (input.text) parts.push({ type: "text", text: input.text });
  input.attachments.forEach((attachment) => parts.push({
    type: "image_url",
    image_url: { url: attachment.dataUrl, detail: "high" },
    meta: { source_type: "attachment", source_name: attachment.name, source_mime: attachment.mimeType, source_size: attachment.size },
  }));
  return parts.length === 1 && parts[0].type === "text" ? input.text : parts;
}

export function operationId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `svelte-ui:${prefix}:${random}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function adaptTool(toolValue: unknown): RawRecord {
  const tool = asRecord(toolValue);
  const name = String(tool.tool ?? tool.name ?? "");
  const args = asRecord(tool.arguments ?? tool.args ?? {});
  if (name === "forge_resource") {
    const action = String(args.action ?? "");
    if (action === "search") return { tool: "search_resources", arguments: args };
    if (action === "inspect") return { tool: "inspect_resource", arguments: { ...args, id: args.resource_id } };
    if (action === "apply") return { tool: "apply_resource", arguments: { ...args, id: args.resource_id } };
  }
  if (name === "initialize_prompt") return { tool: name, arguments: { ...args, positive_prompt: args.positive_prompt ?? args.positive, negative_prompt: args.negative_prompt ?? args.negative } };
  if (name === "edit_prompt") {
    const field = args.field === "negative" ? "negative" : "positive";
    const promptKey = field === "negative" ? "negative_prompt" : "positive_prompt";
    const hashKey = field === "negative" ? "negative_prompt_hash" : "positive_prompt_hash";
    return { tool: name, arguments: { ...args, field, prompt: args.prompt ?? args[promptKey], base_hash: args.base_hash ?? args[hashKey] ?? args.prompt_hash } };
  }
  return { tool: name, arguments: args };
}
