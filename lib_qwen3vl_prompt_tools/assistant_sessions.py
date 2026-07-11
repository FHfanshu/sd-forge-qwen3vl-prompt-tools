from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Iterator

from .assistant import prompt_assistant_stream

SESSION_STATES = {"idle", "running", "waiting", "interrupted", "completed", "failed", "archived"}
RUN_STATES = {"running", "waiting", "interrupted", "completed", "failed", "cancelled"}
EVENT_TYPES = {
    "user_message", "assistant_delta", "reasoning_delta", "assistant_message", "tool_call", "tool_result",
    "ui_mutation", "usage", "checkpoint", "summary", "error", "cancelled", "run_completed",
}
VISIBILITIES = {"model", "ui", "audit"}
DEFAULT_TURN_GUARD = 32


class SessionConflict(RuntimeError):
    pass


class SessionNotFound(RuntimeError):
    pass


def default_session_database() -> Path:
    return Path(__file__).resolve().parents[1] / "data" / "assistant_sessions.sqlite3"


def _now() -> float:
    return time.time()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _decode(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value) if value else fallback
    except json.JSONDecodeError:
        return fallback


def _event_hash(event_type: str, payload: dict[str, Any]) -> str:
    return hashlib.sha256((event_type + "\0" + _json(payload)).encode("utf-8")).hexdigest()


def _public_session(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "session_id": row["session_id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "archived_at": row["archived_at"],
        "state": row["state"],
        "active_run_id": row["active_run_id"],
        "profile_id": row["profile_id"],
        "model_snapshot": _decode(row["model_snapshot_json"], {}),
        "summary": row["summary"] or "",
        "summary_through_sequence": row["summary_through_sequence"] or 0,
        "version": row["version"],
    }


def _public_run(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "run_id": row["run_id"],
        "session_id": row["session_id"],
        "status": row["status"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "user_request_event_id": row["user_request_event_id"],
        "turn_count": row["turn_count"],
        "tool_call_count": row["tool_call_count"],
        "input_tokens": row["input_tokens"],
        "output_tokens": row["output_tokens"],
        "reasoning_tokens": row["reasoning_tokens"],
        "cached_tokens": row["cached_tokens"],
        "stop_reason": row["stop_reason"] or "",
        "error": _decode(row["error_json"], None),
        "lease_expires_at": row["lease_expires_at"],
    }


class AssistantSessionRepository:
    """SQLite-backed append-only assistant sessions.

    A connection is opened per operation so the repository is safe for Forge request
    workers and remains usable after a backend restart.
    """

    def __init__(self, database: str | Path | None = None):
        self.database = Path(database or default_session_database())
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self._migration_lock = threading.Lock()
        self.migrate()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.database), timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def migrate(self) -> None:
        with self._migration_lock, closing(self._connect()) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS agent_sessions (
                    session_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    archived_at REAL,
                    state TEXT NOT NULL,
                    active_run_id TEXT,
                    profile_id TEXT NOT NULL DEFAULT '',
                    model_snapshot_json TEXT NOT NULL DEFAULT '{}',
                    summary TEXT NOT NULL DEFAULT '',
                    summary_through_sequence INTEGER NOT NULL DEFAULT 0,
                    version INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS agent_runs (
                    run_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
                    status TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    finished_at REAL,
                    user_request_event_id TEXT,
                    turn_count INTEGER NOT NULL DEFAULT 0,
                    tool_call_count INTEGER NOT NULL DEFAULT 0,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                    cached_tokens INTEGER NOT NULL DEFAULT 0,
                    stop_reason TEXT NOT NULL DEFAULT '',
                    error_json TEXT,
                    lease_owner TEXT NOT NULL DEFAULT '',
                    lease_expires_at REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS agent_events (
                    event_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
                    run_id TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
                    sequence INTEGER NOT NULL,
                    turn_id INTEGER,
                    event_type TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    payload_json TEXT NOT NULL,
                    visibility TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    UNIQUE(session_id, sequence)
                );
                CREATE INDEX IF NOT EXISTS agent_sessions_recent ON agent_sessions(archived_at, updated_at DESC);
                CREATE INDEX IF NOT EXISTS agent_runs_session ON agent_runs(session_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS agent_events_replay ON agent_events(session_id, sequence);
                """
            )

    def create_session(self, title: str = "", profile_id: str = "", model_snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
        now = _now()
        session_id = uuid.uuid4().hex
        with closing(self._connect()) as connection:
            connection.execute(
                "INSERT INTO agent_sessions(session_id,title,created_at,updated_at,state,profile_id,model_snapshot_json) VALUES(?,?,?,?,?,?,?)",
                (session_id, str(title or "New session").strip() or "New session", now, now, "idle", str(profile_id or ""), _json(model_snapshot or {})),
            )
        return self.get_session(session_id)

    def get_session(self, session_id: str) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            row = connection.execute("SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            raise SessionNotFound("session not found")
        return _public_session(row)

    def list_sessions(self, include_archived: bool = False, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        query = "SELECT * FROM agent_sessions"
        if not include_archived:
            query += " WHERE archived_at IS NULL"
        query += " ORDER BY updated_at DESC LIMIT ?"
        with closing(self._connect()) as connection:
            rows = connection.execute(query, (limit,)).fetchall()
        return [_public_session(row) for row in rows]

    def update_session(self, session_id: str, *, title: str | None = None, archived: bool | None = None, version: int | None = None) -> dict[str, Any]:
        now = _now()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)).fetchone()
            if row is None:
                raise SessionNotFound("session not found")
            if version is not None and int(row["version"]) != int(version):
                raise SessionConflict("session version conflict")
            next_title = str(title).strip() if title is not None else row["title"]
            next_archived_at = (now if archived else None) if archived is not None else row["archived_at"]
            next_state = "archived" if archived else ("idle" if row["state"] == "archived" else row["state"])
            connection.execute(
                "UPDATE agent_sessions SET title=?, archived_at=?, state=?, updated_at=?, version=version+1 WHERE session_id=?",
                (next_title or "New session", next_archived_at, next_state, now, session_id),
            )
            connection.commit()
        return self.get_session(session_id)

    def delete_session(self, session_id: str) -> None:
        with closing(self._connect()) as connection:
            result = connection.execute("DELETE FROM agent_sessions WHERE session_id = ?", (session_id,))
            if result.rowcount != 1:
                raise SessionNotFound("session not found")

    def get_run(self, run_id: str) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            row = connection.execute("SELECT * FROM agent_runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise SessionNotFound("run not found")
        return _public_run(row)

    def _append_event_txn(
        self, connection: sqlite3.Connection, session_id: str, run_id: str | None, event_type: str,
        payload: dict[str, Any], visibility: str, turn_id: int | None = None,
    ) -> dict[str, Any]:
        if event_type not in EVENT_TYPES:
            raise ValueError(f"unsupported event type: {event_type}")
        if visibility not in VISIBILITIES:
            raise ValueError(f"unsupported event visibility: {visibility}")
        row = connection.execute("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_events WHERE session_id = ?", (session_id,)).fetchone()
        now = _now()
        event = {
            "event_id": uuid.uuid4().hex,
            "session_id": session_id,
            "run_id": run_id,
            "sequence": int(row["sequence"]),
            "turn_id": turn_id,
            "event_type": event_type,
            "created_at": now,
            "payload": payload,
            "visibility": visibility,
        }
        connection.execute(
            "INSERT INTO agent_events(event_id,session_id,run_id,sequence,turn_id,event_type,created_at,payload_json,visibility,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (event["event_id"], session_id, run_id, event["sequence"], turn_id, event_type, now, _json(payload), visibility, _event_hash(event_type, payload)),
        )
        connection.execute("UPDATE agent_sessions SET updated_at=?, version=version+1 WHERE session_id=?", (now, session_id))
        return event

    def append_event(
        self, session_id: str, event_type: str, payload: dict[str, Any], *, run_id: str | None = None,
        visibility: str = "model", turn_id: int | None = None,
    ) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM agent_sessions WHERE session_id=?", (session_id,)).fetchone() is None:
                raise SessionNotFound("session not found")
            event = self._append_event_txn(connection, session_id, run_id, event_type, payload, visibility, turn_id)
            connection.commit()
        return event

    def events(self, session_id: str, after_sequence: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 1000))
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM agent_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
                (session_id, max(0, int(after_sequence)), limit),
            ).fetchall()
        return [
            {
                "event_id": row["event_id"], "session_id": row["session_id"], "run_id": row["run_id"],
                "sequence": row["sequence"], "turn_id": row["turn_id"], "event_type": row["event_type"],
                "created_at": row["created_at"], "payload": _decode(row["payload_json"], {}), "visibility": row["visibility"],
            }
            for row in rows
        ]

    def start_run(
        self, session_id: str, user_messages: list[dict[str, Any]], profile_id: str = "", model_snapshot: dict[str, Any] | None = None,
        lease_owner: str = "", lease_seconds: int = 90,
    ) -> dict[str, Any]:
        if not user_messages:
            raise ValueError("user_messages is required")
        now = _now()
        run_id = uuid.uuid4().hex
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute("SELECT * FROM agent_sessions WHERE session_id=?", (session_id,)).fetchone()
            if session is None:
                raise SessionNotFound("session not found")
            if session["state"] == "archived":
                raise SessionConflict("archived session cannot start a run")
            active = session["active_run_id"]
            if active:
                existing = connection.execute("SELECT status, lease_expires_at FROM agent_runs WHERE run_id=?", (active,)).fetchone()
                if existing and existing["status"] == "waiting":
                    raise SessionConflict("session has a resumable run")
                if existing and existing["status"] == "running" and existing["lease_expires_at"] > now:
                    raise SessionConflict("session already has a running lease")
            connection.execute(
                "INSERT INTO agent_runs(run_id,session_id,status,started_at,lease_owner,lease_expires_at) VALUES(?,?,?,?,?,?)",
                (run_id, session_id, "running", now, lease_owner or uuid.uuid4().hex, now + max(1, lease_seconds)),
            )
            last_event = None
            for message in user_messages:
                content = message.get("content") if isinstance(message, dict) else ""
                if not str(content or "").strip() and not (isinstance(message, dict) and message.get("image")):
                    continue
                payload = {key: value for key, value in message.items() if key in {"content", "image", "filename"}}
                last_event = self._append_event_txn(connection, session_id, run_id, "user_message", payload, "model", 0)
            if last_event is None:
                raise ValueError("user_messages is empty")
            snapshot = _json(model_snapshot or _decode(session["model_snapshot_json"], {}))
            connection.execute(
                "UPDATE agent_sessions SET state='running',active_run_id=?,profile_id=?,model_snapshot_json=?,updated_at=?,version=version+1 WHERE session_id=?",
                (run_id, profile_id or session["profile_id"], snapshot, now, session_id),
            )
            connection.execute("UPDATE agent_runs SET user_request_event_id=? WHERE run_id=?", (last_event["event_id"], run_id))
            connection.commit()
        return self.get_run(run_id)

    def resume_run(self, run_id: str, lease_owner: str = "", lease_seconds: int = 90) -> dict[str, Any]:
        now = _now()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if row is None:
                raise SessionNotFound("run not found")
            if row["status"] not in {"waiting", "interrupted", "cancelled"}:
                raise SessionConflict("run is not resumable")
            connection.execute(
                "UPDATE agent_runs SET status='running',finished_at=NULL,stop_reason='',error_json=NULL,lease_owner=?,lease_expires_at=? WHERE run_id=?",
                (lease_owner or uuid.uuid4().hex, now + max(1, lease_seconds), run_id),
            )
            connection.execute(
                "UPDATE agent_sessions SET state='running',active_run_id=?,updated_at=?,version=version+1 WHERE session_id=?",
                (run_id, now, row["session_id"]),
            )
            connection.commit()
        return self.get_run(run_id)

    def append_tool_result(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            if run["status"] not in {"waiting", "running"}:
                raise SessionConflict("run cannot accept a tool result")
            tool_call_id = str(payload.get("tool_call_id") or "").strip()
            if tool_call_id:
                existing = connection.execute(
                    "SELECT * FROM agent_events WHERE run_id=? AND event_type='tool_result' AND json_extract(payload_json, '$.tool_call_id')=?",
                    (run_id, tool_call_id),
                ).fetchone()
                if existing is not None:
                    connection.commit()
                    return {
                        "event_id": existing["event_id"], "session_id": existing["session_id"], "run_id": existing["run_id"],
                        "sequence": existing["sequence"], "turn_id": existing["turn_id"], "event_type": existing["event_type"],
                        "created_at": existing["created_at"], "payload": _decode(existing["payload_json"], {}), "visibility": existing["visibility"],
                    }
            event = self._append_event_txn(connection, run["session_id"], run_id, "tool_result", payload, "model", int(run["turn_count"]))
            connection.commit()
        return event

    def checkpoint(self, run_id: str, status: str, reason: str, error: dict[str, Any] | None = None) -> dict[str, Any]:
        if status not in {"waiting", "interrupted", "failed", "cancelled", "completed"}:
            raise ValueError("invalid checkpoint status")
        session_state = "completed" if status == "completed" else ("failed" if status == "failed" else ("waiting" if status == "waiting" else "interrupted"))
        now = _now()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            payload = {"status": status, "reason": reason}
            if error:
                payload["error"] = error
            self._append_event_txn(connection, run["session_id"], run_id, "checkpoint", payload, "audit", int(run["turn_count"]))
            if status == "cancelled":
                self._append_event_txn(connection, run["session_id"], run_id, "cancelled", payload, "ui", int(run["turn_count"]))
            if status == "completed":
                self._append_event_txn(connection, run["session_id"], run_id, "run_completed", payload, "ui", int(run["turn_count"]))
            connection.execute(
                "UPDATE agent_runs SET status=?,finished_at=?,stop_reason=?,error_json=?,lease_expires_at=0 WHERE run_id=?",
                (status, now, reason, _json(error) if error else None, run_id),
            )
            active_run_id = run_id if status == "waiting" else None
            connection.execute(
                "UPDATE agent_sessions SET state=?,active_run_id=?,updated_at=?,version=version+1 WHERE session_id=?",
                (session_state, active_run_id, now, run["session_id"]),
            )
            connection.commit()
        return self.get_run(run_id)

    def record_turn(self, run_id: str, result: dict[str, Any], turn_id: int) -> list[dict[str, Any]]:
        text = str(result.get("text") or "")
        reasoning = str(result.get("reasoning") or "")
        raw_tool_calls = result.get("tool_calls") if isinstance(result.get("tool_calls"), list) else []
        tool_calls = [
            {**call, "id": str(call.get("id") or f"call_{turn_id}_{index}")}
            for index, call in enumerate(raw_tool_calls) if isinstance(call, dict)
        ]
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            events = []
            if reasoning:
                events.append(self._append_event_txn(connection, run["session_id"], run_id, "reasoning_delta", {"text": reasoning}, "ui", turn_id))
            message = {"content": text, "tool_calls": tool_calls}
            events.append(self._append_event_txn(connection, run["session_id"], run_id, "assistant_message", message, "model", turn_id))
            for call in tool_calls:
                events.append(self._append_event_txn(connection, run["session_id"], run_id, "tool_call", call, "audit", turn_id))
            if usage:
                events.append(self._append_event_txn(connection, run["session_id"], run_id, "usage", usage, "audit", turn_id))
            connection.execute(
                "UPDATE agent_runs SET turn_count=?,tool_call_count=tool_call_count+?,input_tokens=input_tokens+?,output_tokens=output_tokens+?,reasoning_tokens=reasoning_tokens+?,cached_tokens=cached_tokens+? WHERE run_id=?",
                (turn_id, len(tool_calls), int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0), int(usage.get("thought_tokens") or usage.get("reasoning_tokens") or 0), int(usage.get("cached_tokens") or 0), run_id),
            )
            connection.commit()
        return events

    def context_messages(self, session_id: str, token_budget: int = 32768, reserve_tokens: int = 4096) -> list[dict[str, Any]]:
        session = self.get_session(session_id)
        budget = max(1024, int(token_budget) - max(0, int(reserve_tokens)))
        source = [event for event in self.events(session_id, limit=1000) if event["visibility"] == "model"]
        messages: list[dict[str, Any]] = []
        for event in source:
            payload = event["payload"]
            if event["event_type"] == "user_message":
                message = {"role": "user", "content": str(payload.get("content") or "")}
                if payload.get("image"):
                    message["image"] = payload["image"]
                if payload.get("filename"):
                    message["filename"] = payload["filename"]
                messages.append(message)
            elif event["event_type"] == "assistant_message":
                messages.append({"role": "assistant", "content": str(payload.get("content") or ""), "tool_calls": payload.get("tool_calls") or []})
            elif event["event_type"] == "tool_result":
                messages.append({"role": "tool", "tool_call_id": str(payload.get("tool_call_id") or ""), "content": str(payload.get("content") or _json(payload.get("result") or {}))})
        summary = str(session.get("summary") or "").strip()
        if summary:
            messages.insert(0, {"role": "system", "content": "Durable session summary:\n" + summary})

        def token_cost(message: dict[str, Any]) -> int:
            return max(1, (len(str(message.get("content") or "")) + 3) // 4)

        selected: list[dict[str, Any]] = []
        used = 0
        for message in reversed(messages):
            cost = token_cost(message)
            if selected and used + cost > budget:
                continue
            selected.append(message)
            used += cost
        selected.reverse()
        # Never send a tool result without the assistant tool call that introduced it.
        valid_ids = {str(call.get("id") or "") for message in selected if message.get("role") == "assistant" for call in message.get("tool_calls") or []}
        return [message for message in selected if message.get("role") != "tool" or message.get("tool_call_id") in valid_ids]


def sanitized_model_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    secret_fields = {"api_key", "authorization", "headers", "image", "data_url"}

    def sanitize(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: sanitize(item) for key, item in value.items()
                if key not in secret_fields and not key.startswith("_") and key != "messages"
            }
        if isinstance(value, list):
            return [sanitize(item) for item in value]
        return value

    return sanitize(payload)


class AssistantSessionService:
    def __init__(self, repository: AssistantSessionRepository | None = None):
        self.repository = repository or AssistantSessionRepository()

    def start(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
        user_messages = [item for item in messages if isinstance(item, dict) and item.get("role") == "user"]
        if not user_messages and payload.get("user_message"):
            raw = payload["user_message"]
            user_messages = [raw if isinstance(raw, dict) else {"content": str(raw)}]
        return self.repository.start_run(
            session_id, user_messages, str(payload.get("profile_id") or ""), sanitized_model_snapshot(payload), str(payload.get("lease_owner") or ""),
        )

    def stream(self, run_id: str, payload: dict[str, Any]) -> Iterator[str]:
        run = self.repository.get_run(run_id)
        if run["status"] != "running":
            raise SessionConflict("run is not running")
        if int(run["turn_count"]) >= int(payload.get("max_turns") or DEFAULT_TURN_GUARD):
            self.repository.checkpoint(run_id, "waiting", "model turn safety budget reached")
            yield _ndjson("checkpoint", {"status": "waiting", "reason": "model turn safety budget reached"})
            return
        request = dict(payload)
        request["_session_context"] = True
        request["messages"] = self.repository.context_messages(run["session_id"], int(payload.get("context_tokens") or 32768))
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        final: dict[str, Any] | None = None
        try:
            for raw in prompt_assistant_stream(request):
                event = _decode(raw, {})
                event_type = str(event.get("type") or "")
                if event_type == "delta":
                    text_parts.append(str(event.get("text") or ""))
                    self.repository.append_event(run["session_id"], "assistant_delta", {"text": event.get("text") or ""}, run_id=run_id, visibility="ui", turn_id=int(run["turn_count"]) + 1)
                elif event_type == "reasoning_delta":
                    reasoning_parts.append(str(event.get("text") or ""))
                    self.repository.append_event(run["session_id"], "reasoning_delta", {"text": event.get("text") or ""}, run_id=run_id, visibility="ui", turn_id=int(run["turn_count"]) + 1)
                elif event_type == "error":
                    raise RuntimeError(str(event.get("error") or "assistant stream failed"))
                elif event_type == "done":
                    final = dict(event)
                yield raw if raw.endswith("\n") else raw + "\n"
            final = final or {"text": "".join(text_parts), "reasoning": "".join(reasoning_parts), "tool_calls": []}
            final.setdefault("text", "".join(text_parts))
            final.setdefault("reasoning", "".join(reasoning_parts))
            final.setdefault("tool_calls", [])
            calls = final["tool_calls"] if isinstance(final["tool_calls"], list) else []
            if len(calls) > 64:
                self.repository.checkpoint(run_id, "waiting", "malformed response exceeds 64 tool calls")
                yield _ndjson("checkpoint", {"status": "waiting", "reason": "malformed response exceeds 64 tool calls"})
                return
            self.repository.record_turn(run_id, final, int(run["turn_count"]) + 1)
            self.repository.checkpoint(run_id, "waiting" if calls else "completed", "awaiting tool results" if calls else "final response")
        except Exception as exc:  # noqa: BLE001
            current = self.repository.get_run(run_id)
            if current["status"] == "running":
                self.repository.append_event(run["session_id"], "error", {"error": str(exc)}, run_id=run_id, visibility="ui")
                self.repository.checkpoint(run_id, "interrupted", "recoverable backend failure", {"message": str(exc)})
            yield _ndjson("error", {"error": str(exc)})


def _ndjson(event_type: str, payload: dict[str, Any]) -> str:
    return json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n"
