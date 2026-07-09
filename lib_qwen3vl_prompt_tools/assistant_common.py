from __future__ import annotations

import json
import urllib.parse
from typing import Any

from .constants import PROMPT_ASSISTANT_SYSTEM
from .response_text import _clean_response_text

def _assistant_request_messages(messages: list[Any]) -> list[dict[str, str]]:
    request_messages = [{"role": "system", "content": PROMPT_ASSISTANT_SYSTEM}]
    for item in messages[-20:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            request_messages.append({"role": role, "content": content})
    if len(request_messages) == 1:
        raise RuntimeError("message is empty")
    return request_messages
def _assistant_estimate_tokens(text: str) -> int:
    value = str(text or "")
    if not value:
        return 0
    return max(1, (len(value) + 3) // 4)


def _assistant_stream_event(event_type: str, data: dict[str, Any]) -> str:
    return json.dumps({"type": event_type, **data}, ensure_ascii=False) + "\n"
def _extract_tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    result = []

    def append_call(call: Any) -> None:
        if not isinstance(call, dict):
            return
        function = call.get("function")
        function = function if isinstance(function, dict) else {}
        name = str(function.get("name") or call.get("name") or "").strip()
        if isinstance(function, dict) and function.get("arguments") is not None:
            raw_args = function.get("arguments")
        else:
            raw_args = call.get("arguments", call.get("input", call.get("args")))
        if not name:
            return
        arguments: Any = raw_args or {}
        if isinstance(raw_args, str):
            try:
                arguments = json.loads(raw_args) if raw_args.strip() else {}
            except json.JSONDecodeError:
                arguments = {"diff": raw_args}
        if not isinstance(arguments, dict):
            arguments = {}
        result.append({"tool": name, "arguments": arguments})

    calls = message.get("tool_calls") or []
    if isinstance(calls, str):
        try:
            calls = json.loads(calls) if calls.strip() else []
        except json.JSONDecodeError:
            calls = []
    if isinstance(calls, dict):
        calls = [calls]
    for call in calls:
        append_call(call)

    append_call(message.get("function_call"))

    content = message.get("content")
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and str(part.get("type") or "") in {"tool_use", "tool_call", "function_call"}:
                append_call(part)
    return result


def _assistant_chat_url(endpoint: str) -> str:
    endpoint = endpoint.strip().rstrip("/")
    if endpoint.endswith("/chat/completions"):
        return endpoint
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.netloc.lower() == "api.deepseek.com":
        base_path = parsed.path.rstrip("/")
        path = f"{base_path}/chat/completions"
        return urllib.parse.urlunparse((parsed.scheme or "https", parsed.netloc, path, "", "", ""))
    if endpoint.endswith("/v1"):
        return endpoint + "/chat/completions"
    return endpoint + "/v1/chat/completions"
