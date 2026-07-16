from __future__ import annotations

import json
import time
import uuid
from typing import Any


_STATE_KEY = "loom:message_queue_v1"
_TERMINAL_STATES = {"delivered", "cancelled"}
_TERMINAL_RETAIN = 50
_OPERATION_RETAIN = 200


def _json_value(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


class LoomMessageQueue:
    """Durable Loom queue stored inside the active KT SessionStore."""

    def __init__(self, store: Any, agent_name: str):
        self.store = store
        self.agent_name = agent_name

    def list(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self._load()["messages"]]

    def active(self) -> list[dict[str, Any]]:
        return [item for item in self.list() if item.get("state") not in _TERMINAL_STATES]

    def enqueue(
        self,
        content: Any,
        *,
        kind: str,
        display_content: str = "",
        attachments: list[dict[str, Any]] | None = None,
        turn_id: str = "",
        operation_id: str = "",
    ) -> dict[str, Any]:
        if kind not in {"primary", "guide"}:
            raise ValueError("message kind must be primary or guide")
        state = self._load()
        state["sequence"] += 1
        item = {
            "message_id": uuid.uuid4().hex,
            "sequence": state["sequence"],
            "kind": kind,
            "state": "pending" if kind == "primary" else "guide_waiting",
            "content": _json_value(content),
            "display_content": str(display_content or ""),
            "attachments": _json_value(attachments or []),
            "created_at": time.time(),
            "updated_at": time.time(),
            "turn_id": str(turn_id or ""),
            "claimed_at": None,
            "error": "",
            "operation_id": str(operation_id or ""),
        }
        state["messages"].append(item)
        self._save(state)
        self._event("loom_message_queued", item)
        return dict(item)

    def get(self, message_id: str) -> dict[str, Any]:
        for item in self._load()["messages"]:
            if item.get("message_id") == message_id:
                return dict(item)
        raise KeyError(message_id)

    def by_operation(self, operation_id: str) -> dict[str, Any] | None:
        operation_id = str(operation_id or "")
        if not operation_id:
            return None
        message = next(
            (dict(item) for item in self._load()["messages"] if item.get("operation_id") == operation_id),
            None,
        )
        if message is not None:
            return message
        return next(
            (dict(item) for item in self._load()["operations"] if item.get("operation_id") == operation_id),
            None,
        )

    def operations(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self._load()["operations"]]

    def edit(
        self,
        message_id: str,
        content: Any,
        display_content: str = "",
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        state, item = self._mutable(message_id)
        if item["state"] not in {"pending", "guide_waiting"}:
            raise RuntimeError("message is already claimed")
        item["content"] = _json_value(content)
        item["display_content"] = str(display_content or item.get("display_content") or "")
        if attachments is not None:
            item["attachments"] = _json_value(attachments)
        item["updated_at"] = time.time()
        item["error"] = ""
        self._save(state)
        self._event("loom_message_edited", item)
        return dict(item)

    def cancel(self, message_id: str) -> dict[str, Any]:
        state, item = self._mutable(message_id)
        if item["state"] not in {"pending", "guide_waiting"}:
            raise RuntimeError("message is already claimed")
        item["state"] = "cancelled"
        item["updated_at"] = time.time()
        self._save(state)
        self._event("loom_message_cancelled", item)
        return dict(item)

    def mark(self, message_id: str, target: str, **updates: Any) -> dict[str, Any]:
        state, item = self._mutable(message_id)
        item["state"] = target
        item["updated_at"] = time.time()
        item.update(_json_value(updates))
        self._save(state)
        self._event(f"loom_message_{target}", item)
        return dict(item)

    def next_primary(self) -> dict[str, Any] | None:
        candidates = [
            item for item in self._load()["messages"]
            if item.get("kind") == "primary" and item.get("state") in {"pending", "failed"}
        ]
        return dict(min(candidates, key=lambda item: item["sequence"])) if candidates else None

    def pending_primary_count(self) -> int:
        return sum(
            item.get("kind") == "primary" and item.get("state") in {"pending", "failed"}
            for item in self._load()["messages"]
        )

    def waiting_guides(self) -> list[dict[str, Any]]:
        return [
            dict(item) for item in self._load()["messages"]
            if item.get("kind") == "guide" and item.get("state") == "guide_waiting"
        ]

    def has_failed_primary(self) -> bool:
        return any(
            item.get("kind") == "primary" and item.get("state") == "failed"
            for item in self._load()["messages"]
        )

    def recover_interrupted(self) -> list[dict[str, Any]]:
        state = self._load()
        changed: list[dict[str, Any]] = []
        for item in state["messages"]:
            if item.get("state") == "guide_waiting":
                item["kind"] = "primary"
                item["state"] = "pending"
                item["updated_at"] = time.time()
                changed.append(dict(item))
            elif item.get("state") in {"running", "claimed"}:
                if item.get("state") == "claimed":
                    item["kind"] = "primary"
                item["state"] = "failed"
                item["error"] = "Runtime interrupted before the turn completed"
                item["updated_at"] = time.time()
                changed.append(dict(item))
        if changed:
            self._save(state)
            for item in changed:
                self._event("loom_message_recovered", item)
        return changed

    def _load(self) -> dict[str, Any]:
        try:
            value = self.store.state.get(_STATE_KEY)
        except (KeyError, TypeError):
            value = None
        if not isinstance(value, dict) or not isinstance(value.get("messages"), list):
            return {"sequence": 0, "messages": [], "operations": []}
        normalized = _json_value(value)
        if not isinstance(normalized.get("operations"), list):
            normalized["operations"] = []
        return normalized

    def _save(self, state: dict[str, Any]) -> None:
        operations = {
            item.get("operation_id"): dict(item)
            for item in state.get("operations", [])
            if item.get("operation_id")
        }
        for item in state["messages"]:
            operation_id = item.get("operation_id")
            if operation_id:
                operations[operation_id] = dict(item)
        state["operations"] = sorted(
            operations.values(),
            key=lambda item: float(item.get("updated_at") or 0),
        )[-_OPERATION_RETAIN:]
        terminal = [item for item in state["messages"] if item.get("state") in _TERMINAL_STATES]
        keep_terminal = {item.get("message_id") for item in terminal[-_TERMINAL_RETAIN:]}
        state["messages"] = [
            item for item in state["messages"]
            if item.get("state") not in _TERMINAL_STATES or item.get("message_id") in keep_terminal
        ]
        self.store.state[_STATE_KEY] = _json_value(state)

    def _mutable(self, message_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        state = self._load()
        for item in state["messages"]:
            if item.get("message_id") == message_id:
                return state, item
        raise KeyError(message_id)

    def _event(self, event_type: str, item: dict[str, Any]) -> None:
        payload = {
            "message_id": item.get("message_id"),
            "sequence": item.get("sequence"),
            "kind": item.get("kind"),
            "state": item.get("state"),
            "turn_id": item.get("turn_id", ""),
            "error": item.get("error", ""),
        }
        if event_type in {"loom_message_queued", "loom_message_edited"}:
            payload["content"] = item.get("content")
        self.store.append_event(
            self.agent_name,
            event_type,
            payload,
        )
