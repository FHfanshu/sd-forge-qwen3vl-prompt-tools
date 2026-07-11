# Agent Session System Design

## Goals

The assistant should survive page refreshes, long tool workflows, context-window pressure, and recoverable backend failures without silently losing progress. A session is an append-only record of user messages, model output, reasoning display data, tool requests, tool results, UI mutations, checkpoints, and run status.

The session layer must not make model reasoning part of the next model request by default. Reasoning is display/audit metadata; normal conversation content and tool exchanges remain the authoritative model context.

## Identity and lifecycle

Each session has a stable `session_id`. Each user submission creates a `run_id`; every model round within that run has a monotonically increasing `turn_id`. Tool calls retain provider call IDs when available and otherwise receive stable local IDs.

Session states:

- `idle`: ready for input.
- `running`: a run owns the session execution lease.
- `waiting`: execution can continue but needs user input or approval.
- `interrupted`: browser, network, or backend stopped during a recoverable run.
- `completed`: the last run produced a final response.
- `failed`: an unrecoverable protocol or tool error occurred.
- `archived`: hidden from the normal session list but retained.

Runs are resumable. A safety budget pause records a checkpoint and changes the state to `waiting` or `interrupted`; it must not discard the event log or present the run as irrecoverably stopped.

## Storage model

Use SQLite on the Forge backend. Browser `localStorage` may keep only the active session ID, panel preferences, and an unsent draft. It must not be the source of truth for conversation history.

Suggested tables:

### `agent_sessions`

- `session_id` primary key
- `title`, `created_at`, `updated_at`, `archived_at`
- `state`, `active_run_id`
- `profile_id`, `model_snapshot_json`
- `summary`, `summary_through_sequence`
- `version` for optimistic concurrency

### `agent_runs`

- `run_id` primary key, `session_id` foreign key
- `status`, `started_at`, `finished_at`
- `user_request_event_id`
- `turn_count`, `tool_call_count`
- `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_tokens`
- `stop_reason`, `error_json`
- `lease_owner`, `lease_expires_at`

### `agent_events`

- `event_id` primary key, `session_id`, `run_id`
- `sequence` unique within a session
- `turn_id`, `event_type`, `created_at`
- `payload_json`
- `visibility`: `model`, `ui`, or `audit`
- `content_hash` for deduplication

Event types include `user_message`, `assistant_delta`, `reasoning_delta`, `assistant_message`, `tool_call`, `tool_result`, `ui_mutation`, `usage`, `checkpoint`, `summary`, `error`, `cancelled`, and `run_completed`.

Streaming deltas may be buffered and coalesced into bounded chunks before database writes. The final assistant message and usage totals are always persisted transactionally.

## Context construction

Do not truncate the serialized message array by character count. Build context from structured events using a token budget derived from the selected model profile:

1. Reserve space for system instructions, tool schemas, and expected output.
2. Always include the current user request and unresolved tool exchange.
3. Include recent complete turns from newest to oldest.
4. Include the latest durable session summary for older turns.
5. Include pinned facts and UI state checkpoints.
6. Drop verbose successful tool payloads only after replacing them with a structured digest and artifact reference.

Never split a `tool_call` from its matching `tool_result`. Never truncate JSON into invalid content. Large results should be stored as artifacts and represented in context by metadata, a digest, and retrievable ranges.

Summarization runs asynchronously after a configurable threshold, not in the critical request path. A new summary supersedes older summaries only after it is committed with the last covered event sequence.

## Execution budgets

Budgets are observability and recovery mechanisms, not arbitrary low ceilings.

- No fixed cumulative tool-call limit for a normal run.
- A high model-turn guard (initially 32) creates a resumable checkpoint.
- A malformed single response containing more than 64 tool calls is paused before execution.
- Repetition detection uses normalized tool name and arguments plus result hashes. Warn at four identical consecutive calls and pause at six only when neither arguments nor observed result changes.
- Time and token budgets come from the model profile and can be extended on resume.
- User cancellation aborts active requests and records a resumable checkpoint.

Mutation tools should support idempotency keys using `session_id/run_id/tool_call_id`. Retrying a timed-out mutation must first query its recorded outcome instead of blindly applying it twice.

## Backend API

Initial endpoints:

- `POST /assistant/sessions`: create a session.
- `GET /assistant/sessions`: list recent sessions.
- `GET /assistant/sessions/{id}`: load metadata and paginated events.
- `PATCH /assistant/sessions/{id}`: rename or archive.
- `POST /assistant/sessions/{id}/runs`: submit a user request and start streaming.
- `POST /assistant/runs/{id}/cancel`: cancel and checkpoint.
- `POST /assistant/runs/{id}/resume`: resume an interrupted or budget-paused run.
- `GET /assistant/runs/{id}/events`: SSE replay from `Last-Event-ID`.

All mutation endpoints use optimistic version checks or idempotency keys. SSE event IDs are the persisted session sequence so reconnecting clients can replay missed events without duplicating UI messages.

## Frontend behavior

The panel loads the active session, then subscribes to its run event stream. A refresh reconnects with the last rendered event ID. The UI exposes:

- new session and session history;
- rename, archive, and delete-with-confirmation;
- running, interrupted, waiting, and completed states;
- resume from checkpoint;
- token totals per run and session;
- collapsible reasoning stored with `ui` visibility;
- tool timeline with pending, running, succeeded, failed, and unknown-outcome states.

The send button never starts two owners for the same session. A backend lease prevents duplicate execution from multiple tabs; other tabs may observe the stream.

## Security and retention

API keys never enter session events. Sensitive prompt sanitization happens before remote transmission, while the local event record follows an explicit retention setting. Reasoning retention can be disabled independently. Artifact paths are validated and kept inside an extension-managed data directory.

Default retention should be configurable by age and total storage. Deletion removes session rows and associated artifacts in one managed operation. Export produces a versioned JSON document with secrets excluded.

## Delivery phases

1. Add event schemas, SQLite repository, migrations, and repository tests.
2. Persist sessions/runs/final messages while retaining the existing streaming endpoint.
3. Persist and replay SSE events; add reconnect and refresh recovery.
4. Replace character-based compaction with token-budgeted context assembly and summaries.
5. Add session list, resume controls, tool timeline, archive/delete, and export.
6. Add multi-tab leases, artifact-backed large tool results, retention jobs, and crash-recovery tests.

## Acceptance criteria

- Refreshing during a stream resumes without duplicated text or tool execution.
- A completed tool call is never repeated solely because the browser disconnected.
- Context compression preserves paired tool calls/results and current user intent.
- Safety budget pauses can resume from the latest checkpoint.
- Session history survives Forge restarts.
- Tests cover migration, replay, idempotency, cancellation, resume, multi-tab leasing, compaction, and deletion.
