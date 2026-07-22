from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any


_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,191}")
_MAX_SESSIONS = 1_000
_MAX_MESSAGES_PER_SESSION = 10_000
_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024


class SessionSyncError(ValueError):
    pass


class SessionSyncAuthority:
    """Server-side durable snapshots for cross-browser session synchronization."""

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.database_path = self.root / "sessions.sqlite3"

    def sync(self, payload: Any) -> dict[str, Any]:
        device_id, incoming = _normalize_request(payload)
        self.root.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection:
            self._initialize(connection)
            connection.execute("BEGIN IMMEDIATE")
            conflicts: list[dict[str, str]] = []
            for snapshot in incoming:
                conflict = self._merge_snapshot(connection, device_id, snapshot)
                if conflict:
                    conflicts.append(conflict)
            connection.commit()
            rows = connection.execute(
                "SELECT snapshot, revision FROM session_snapshots ORDER BY updated_at DESC, session_id ASC"
            ).fetchall()
        sessions = []
        for snapshot_json, revision in rows:
            snapshot = json.loads(snapshot_json)
            snapshot["revision"] = revision
            snapshot["content_hash"] = hashlib.sha256(_canonical_snapshot(snapshot).encode("utf-8")).hexdigest()
            sessions.append(snapshot)
        return {"version": 1, "sessions": sessions, "conflicts": conflicts}

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    @staticmethod
    def _initialize(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS session_snapshots (
                session_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                source_device TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                snapshot TEXT NOT NULL
            )
            """
        )

    def _merge_snapshot(
        self,
        connection: sqlite3.Connection,
        device_id: str,
        incoming: dict[str, Any],
    ) -> dict[str, str] | None:
        session_id = incoming["session"]["id"]
        base_revision = incoming.get("revision")
        canonical = _canonical_snapshot(incoming)
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        existing = connection.execute(
            "SELECT revision, content_hash FROM session_snapshots WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if existing is None:
            self._write(connection, incoming, device_id, digest, 1)
            return None

        revision, existing_hash = existing
        if digest == existing_hash:
            return None
        if incoming.get("base_hash") == digest:
            return None
        if base_revision == revision:
            self._write(connection, incoming, device_id, digest, revision + 1)
            return None

        conflict_id = f"{session_id}-conflict-{uuid.uuid4().hex[:8]}"
        conflict = _fork_snapshot(incoming, conflict_id)
        conflict_digest = hashlib.sha256(_canonical_snapshot(conflict).encode("utf-8")).hexdigest()
        self._write(connection, conflict, device_id, conflict_digest, 1)
        return {"session_id": session_id, "conflict_session_id": conflict_id}

    @staticmethod
    def _write(
        connection: sqlite3.Connection,
        snapshot: dict[str, Any],
        device_id: str,
        digest: str,
        revision: int,
    ) -> None:
        session_id = snapshot["session"]["id"]
        connection.execute(
            """
            INSERT INTO session_snapshots(session_id, revision, updated_at, source_device, content_hash, snapshot)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                revision = excluded.revision,
                updated_at = excluded.updated_at,
                source_device = excluded.source_device,
                content_hash = excluded.content_hash,
                snapshot = excluded.snapshot
            """,
            (
                session_id,
                revision,
                int(snapshot["session"]["updatedAt"]),
                device_id,
                digest,
                _canonical_snapshot(snapshot),
            ),
        )


def _normalize_request(payload: Any) -> tuple[str, list[dict[str, Any]]]:
    if not isinstance(payload, dict):
        raise SessionSyncError("request body must be an object")
    device_id = _identifier(payload.get("device_id"), "device_id")
    sessions = payload.get("sessions")
    if not isinstance(sessions, list) or len(sessions) > _MAX_SESSIONS:
        raise SessionSyncError(f"sessions must be an array with at most {_MAX_SESSIONS} items")
    return device_id, [_normalize_snapshot(item) for item in sessions]


def _normalize_snapshot(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SessionSyncError("session snapshot must be an object")
    session = value.get("session")
    messages = value.get("messages")
    if not isinstance(session, dict) or not isinstance(messages, list):
        raise SessionSyncError("session snapshot requires session and messages")
    if len(messages) > _MAX_MESSAGES_PER_SESSION:
        raise SessionSyncError("session has too many messages")

    session_id = _identifier(session.get("id"), "session.id")
    normalized_session = {
        "id": session_id,
        "title": _text(session.get("title"), "session.title", 512),
        "createdAt": _timestamp(session.get("createdAt"), "session.createdAt"),
        "updatedAt": _timestamp(session.get("updatedAt"), "session.updatedAt"),
        "profileId": _identifier(session.get("profileId"), "session.profileId"),
        "providerId": _text(session.get("providerId"), "session.providerId", 256),
        "modelId": _text(session.get("modelId"), "session.modelId", 512),
        "reasoningLevel": _text(session.get("reasoningLevel"), "session.reasoningLevel", 64),
        "systemPrompt": _text(session.get("systemPrompt"), "session.systemPrompt", 200_000),
        "schemaVersion": _positive_integer(session.get("schemaVersion"), "session.schemaVersion"),
    }
    normalized_messages = [_normalize_message(item, session_id) for item in messages]
    revision = value.get("revision")
    base_hash = value.get("base_hash")
    result: dict[str, Any] = {"session": normalized_session, "messages": normalized_messages}
    if revision is not None:
        result["revision"] = _positive_integer(revision, "revision")
    if base_hash is not None:
        if not isinstance(base_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", base_hash):
            raise SessionSyncError("base_hash must be a SHA-256 digest")
        result["base_hash"] = base_hash
    if len(_canonical_snapshot(result).encode("utf-8")) > _MAX_SNAPSHOT_BYTES:
        raise SessionSyncError("session snapshot is too large")
    return result


def _normalize_message(value: Any, session_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SessionSyncError("message must be an object")
    message_id = _identifier(value.get("id"), "message.id")
    if value.get("sessionId") != session_id:
        raise SessionSyncError("message.sessionId must match session.id")
    status = value.get("status")
    if status not in {"complete", "streaming", "interrupted", "failed"}:
        raise SessionSyncError("message.status is invalid")
    message = value.get("message")
    if not isinstance(message, dict):
        raise SessionSyncError("message.message must be an object")
    return {
        "id": message_id,
        "sessionId": session_id,
        "message": message,
        "status": status,
        "createdAt": _timestamp(value.get("createdAt"), "message.createdAt"),
        "updatedAt": _timestamp(value.get("updatedAt"), "message.updatedAt"),
    }


def _fork_snapshot(snapshot: dict[str, Any], conflict_id: str) -> dict[str, Any]:
    session = dict(snapshot["session"])
    original_id = session["id"]
    session["id"] = conflict_id
    session["title"] = f"{session['title']} (conflict copy)"[:512]
    session["updatedAt"] = max(int(session["updatedAt"]), int(time.time() * 1000))
    messages = []
    for item in snapshot["messages"]:
        message = dict(item)
        message["id"] = _fork_message_id(str(message["id"]), original_id, conflict_id)
        message["sessionId"] = conflict_id
        messages.append(message)
    return {"session": session, "messages": messages}


def _fork_message_id(message_id: str, original_id: str, conflict_id: str) -> str:
    if message_id.startswith(f"{original_id}:"):
        return f"{conflict_id}:{message_id[len(original_id) + 1:]}"
    return f"{conflict_id}:{hashlib.sha256(message_id.encode('utf-8')).hexdigest()[:24]}"


def _canonical_snapshot(snapshot: dict[str, Any]) -> str:
    value = {"session": snapshot["session"], "messages": snapshot["messages"]}
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not _SAFE_ID.fullmatch(value):
        raise SessionSyncError(f"{name} must be a safe identifier")
    return value


def _text(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise SessionSyncError(f"{name} must be a string with at most {maximum} characters")
    return value


def _timestamp(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise SessionSyncError(f"{name} must be a non-negative integer")
    return value


def _positive_integer(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise SessionSyncError(f"{name} must be a positive integer")
    return value
