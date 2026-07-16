from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from kohaku_loom.assistant import prompt_assistant_chat
from kohaku_loom.assistant_local import cancel_local_assistant_run
from kohaku_loom.assistant_profiles import LLAMA_ONCE


METADATA_SUFFIX = ".kohakutr.meta.json"
MAX_TITLE_CHARS = 80
MAX_DESCRIPTION_CHARS = 180


def metadata_path(session_path: Path) -> Path:
    return session_path.with_name(session_path.name + ".meta.json")


def read_metadata(session_path: Path) -> dict[str, Any]:
    path = metadata_path(session_path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        value = {}
    return value if isinstance(value, dict) else {}


def write_metadata(session_path: Path, value: dict[str, Any]) -> dict[str, Any]:
    path = metadata_path(session_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)
    return dict(value)


def normalize_branch_view(value: Any, *, strict: bool = False) -> dict[int, int]:
    """Normalize the JSON-friendly branch selection map."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        if strict:
            raise ValueError("branch_view must be an object")
        return {}
    result: dict[int, int] = {}
    for raw_turn, raw_branch in value.items():
        try:
            if isinstance(raw_turn, bool) or isinstance(raw_branch, bool):
                raise ValueError
            if isinstance(raw_turn, float) and not raw_turn.is_integer():
                raise ValueError
            if isinstance(raw_branch, float) and not raw_branch.is_integer():
                raise ValueError
            turn_index = int(raw_turn)
            branch_id = int(raw_branch)
        except (TypeError, ValueError):
            if strict:
                raise ValueError("branch_view keys and values must be integers") from None
            continue
        if turn_index <= 0 or branch_id <= 0:
            if strict:
                raise ValueError("branch_view turn and branch IDs must be positive")
            continue
        result[turn_index] = branch_id
    return dict(sorted(result.items()))


def serialize_branch_view(value: Any) -> dict[str, int]:
    return {str(turn): branch for turn, branch in normalize_branch_view(value).items()}


def metadata_payload(session_id: str, session_path: Path) -> dict[str, Any]:
    value = read_metadata(session_path)
    status = str(value.get("status") or "pending")
    stored_count = value.get("message_count")
    message_count = int(stored_count) if stored_count is not None else len(source_messages(value.get("source")))
    return {
        "session_id": session_id,
        "title": str(value.get("title") or ""),
        "description": str(value.get("description") or ""),
        "status": status,
        "profile_id": str(value.get("profile_id") or ""),
        "created_at": value.get("created_at"),
        "updated_at": value.get("updated_at"),
        "error": str(value.get("error") or ""),
        "retry_count": int(value.get("retry_count") or 0),
        "message_count": max(0, message_count),
        "branch_view": normalize_branch_view(value.get("branch_view")),
    }


def fallback_metadata(messages: list[dict[str, Any]]) -> tuple[str, str]:
    user, assistant = _conversation_text(messages)
    title = _truncate(user, MAX_TITLE_CHARS) or "New session"
    description = _truncate(user or assistant, MAX_DESCRIPTION_CHARS)
    return title, description


def metadata_source(messages: list[dict[str, Any]]) -> dict[str, str]:
    user, assistant = _conversation_text(messages)
    return {"user": _truncate(user, 4000), "assistant": _truncate(assistant, 3000)}


def source_messages(value: Any) -> list[dict[str, Any]]:
    source = value if isinstance(value, dict) else {}
    result = []
    if str(source.get("user") or "").strip():
        result.append({"role": "user", "content": str(source["user"])})
    if str(source.get("assistant") or "").strip():
        result.append({"role": "assistant", "content": str(source["assistant"])})
    return result


def generate_metadata(profile: dict[str, Any], messages: list[dict[str, Any]], run_id: str = "") -> tuple[str, str]:
    user, assistant = _conversation_text(messages)
    fallback_title, fallback_description = fallback_metadata(messages)
    prompt = (
        "为助手会话生成历史记录元数据。只输出两行，严格使用以下格式：\n"
        "TITLE: 不超过 60 字的会话标题\n"
        "DESCRIPTION: 不超过 140 字的一句说明，概括用户目标和当前结果\n\n"
        "不要使用 Markdown、引号、解释或额外行。使用用户的语言。\n\n"
        f"用户目标：\n{_truncate(user, 4000)}\n\n"
        f"当前结果：\n{_truncate(assistant, 3000)}"
    )
    payload = dict(profile)
    payload.update(
        {
            "messages": [{"role": "user", "content": prompt}],
            "disable_tools": True,
            "thinking": False,
            "temperature": 0.15,
            "top_p": 0.9,
            "max_tokens": 160,
            "run_id": run_id,
        }
    )
    result = prompt_assistant_chat(payload)
    return _parse_generated_metadata(str(result.get("text") or ""), fallback_title, fallback_description)


class SessionMetadataQueue:
    """Runs one short-lived local naming job at a time without blocking turns."""

    def __init__(
        self,
        profile_resolver: Callable[[], dict[str, Any]],
        messages_for_session: Callable[[str], list[dict[str, Any]]],
        session_path_for_id: Callable[[str], Path],
        turn_is_active: Callable[[], bool],
        publish: Callable[[str, dict[str, Any]], Any],
    ):
        self._profile_resolver = profile_resolver
        self._messages_for_session = messages_for_session
        self._session_path_for_id = session_path_for_id
        self._turn_is_active = turn_is_active
        self._publish = publish
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()
        self._current_run_id = ""

    def schedule(self, session_id: str, *, force: bool = False) -> dict[str, Any]:
        path = self._session_path_for_id(session_id)
        current = metadata_payload(session_id, path)
        task = self._tasks.get(session_id)
        if task and not task.done():
            return current
        if current["status"] == "completed" and not force:
            return current
        messages = [message for message in self._messages_for_session(session_id) if isinstance(message, dict)]
        visible_messages = [message for message in messages if str(message.get("role") or "").lower() != "system"]
        source = metadata_source(messages)
        if not source["user"] and not source["assistant"]:
            return current
        source = read_metadata(path).get("source") or source
        now = time.time()
        next_value = {
            **read_metadata(path),
            "version": 1,
            "session_id": session_id,
            "title": current["title"],
            "description": current["description"],
            "status": "pending",
            "created_at": current["created_at"] or now,
            "updated_at": now,
            "error": "",
            "retry_count": current["retry_count"],
            "message_count": len(visible_messages),
            "source": source,
        }
        write_metadata(path, next_value)
        self._tasks[session_id] = asyncio.create_task(self._run(session_id), name=f"loom-session-metadata-{session_id}")
        return metadata_payload(session_id, path)

    async def close(self) -> None:
        self.interrupt()
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    def interrupt(self) -> None:
        """Yield GPU ownership to an interactive primary turn."""
        if self._current_run_id:
            cancel_local_assistant_run(self._current_run_id)

    async def _run(self, session_id: str) -> None:
        path = self._session_path_for_id(session_id)
        try:
            async with self._lock:
                # The primary assistant owns GPU time. Metadata waits rather than competing with it.
                while self._turn_is_active():
                    await asyncio.sleep(0.25)
                current = metadata_payload(session_id, path)
                generating = {
                    **read_metadata(path),
                    "version": 1,
                    "session_id": session_id,
                    "status": "generating",
                    "created_at": current["created_at"] or time.time(),
                    "updated_at": time.time(),
                    "error": "",
                }
                write_metadata(path, generating)
                await self._emit(session_id, path)
                profile = self._profile_resolver()
                if str(profile.get("runtime") or "") != LLAMA_ONCE:
                    raise RuntimeError("会话命名模型必须使用 llama-once")
                messages = source_messages(read_metadata(path).get("source"))
                if not messages:
                    raise RuntimeError("会话命名缺少可用的对话来源")
                run_id = uuid.uuid4().hex
                self._current_run_id = run_id
                title, description = await asyncio.to_thread(generate_metadata, profile, messages, run_id)
                completed = {
                    **generating,
                    "title": title,
                    "description": description,
                    "status": "completed",
                    "profile_id": str(profile.get("profile_id") or ""),
                    "updated_at": time.time(),
                }
                write_metadata(path, completed)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            current = metadata_payload(session_id, path)
            try:
                source = read_metadata(path).get("source") or {}
                title, description = fallback_metadata(source_messages(source))
            except Exception:  # noqa: BLE001
                title, description = current["title"], current["description"]
                source = read_metadata(path).get("source") or {}
            fallback = {
                **read_metadata(path),
                "version": 1,
                "session_id": session_id,
                "title": title,
                "description": description,
                "status": "fallback",
                "created_at": current["created_at"] or time.time(),
                "updated_at": time.time(),
                "error": str(error),
                "retry_count": current["retry_count"] + 1,
                "source": source,
            }
            write_metadata(path, fallback)
        finally:
            self._current_run_id = ""
            await self._emit(session_id, path)
            self._tasks.pop(session_id, None)

    async def _emit(self, session_id: str, path: Path) -> None:
        result = self._publish("session_metadata_updated", metadata_payload(session_id, path))
        if asyncio.iscoroutine(result):
            await result


def _conversation_text(messages: list[dict[str, Any]]) -> tuple[str, str]:
    user = ""
    assistant = ""
    for message in messages:
        if not isinstance(message, dict):
            continue
        text = _message_text(message.get("content"))
        if not text:
            continue
        if message.get("role") == "user" and not user:
            user = text
        elif message.get("role") == "assistant":
            assistant = text
    return user, assistant


def _message_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, list):
        return ""
    return "\n".join(str(item.get("text") or "") for item in value if isinstance(item, dict) and item.get("type") == "text").strip()


def _parse_generated_metadata(text: str, fallback_title: str, fallback_description: str) -> tuple[str, str]:
    title = ""
    description = ""
    for line in text.splitlines():
        key, separator, value = line.partition(":")
        if not separator:
            continue
        if key.strip().upper() == "TITLE":
            title = value.strip()
        elif key.strip().upper() == "DESCRIPTION":
            description = value.strip()
    title = _truncate(_clean(title), MAX_TITLE_CHARS) or fallback_title
    description = _truncate(_clean(description), MAX_DESCRIPTION_CHARS) or fallback_description
    return title, description


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().strip("\"'`#* ")


def _truncate(value: str, limit: int) -> str:
    text = _clean(value)
    return text if len(text) <= limit else text[: max(1, limit - 1)].rstrip() + "…"
