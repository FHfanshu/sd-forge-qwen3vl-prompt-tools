from __future__ import annotations

import json
import os
import urllib.parse
from typing import Any

import requests

from .assistant_common import _assistant_chat_url, _assistant_request_messages, _assistant_stream_event, _extract_tool_calls
from .assistant_gemini import _assistant_use_gemini_native, _prompt_assistant_chat_gemini, _prompt_assistant_stream_gemini
from .assistant_local import _prompt_assistant_chat_local_once
from .constants import (
    ASSISTANT_TOOLS,
    DEFAULT_ASSISTANT_BACKEND,
    DEFAULT_ASSISTANT_ENDPOINT,
    DEFAULT_ASSISTANT_FALLBACK_BACKEND,
    DEFAULT_ASSISTANT_FALLBACK_MODEL,
    DEFAULT_ASSISTANT_MODEL,
    DEFAULT_LOCAL_ASSISTANT_ENDPOINT,
    DEFAULT_LOCAL_ASSISTANT_MODEL,
)
from .response_text import _clean_response_text, _extract_message_text
from .utils import _payload_bool


def ask_teacher(payload: dict[str, Any]) -> dict[str, Any]:
    question = str(payload.get("question") or payload.get("teacher_question") or payload.get("prompt") or "").strip()
    context = str(payload.get("context") or payload.get("teacher_context") or "").strip()
    goal = str(payload.get("goal") or "").strip()
    if not question and not context:
        raise RuntimeError("ask_teacher requires question or context")
    endpoint = str(payload.get("endpoint") or DEFAULT_ASSISTANT_ENDPOINT).strip().rstrip("/")
    model = str(payload.get("model") or DEFAULT_ASSISTANT_MODEL).strip()
    teacher_prompt = (
        "You are the remote Gemini teacher for a local Qwen prompt agent. "
        "Review the sanitized context and answer with practical prompt-engineering guidance. "
        "Do not request tools, do not expand SAFE_SLOT_### placeholders, and do not ask for raw sensitive text."
    )
    parts = [teacher_prompt]
    if goal:
        parts.append(f"Goal: {goal}")
    if context:
        parts.append(f"Sanitized context:\n{context}")
    if question:
        parts.append(f"Question:\n{question}")
    teacher_payload = dict(payload)
    teacher_payload.update(
        {
            "backend": "moyuu",
            "messages": [{"role": "user", "content": "\n\n".join(parts)}],
            "teacher_mode": "regex",
            "disable_tools": True,
            "max_tokens": int(payload.get("teacher_max_tokens") or payload.get("max_tokens") or 1200),
        }
    )
    api_key = _assistant_api_key(teacher_payload, "moyuu")
    result = _prompt_assistant_chat_gemini(teacher_payload, endpoint, model, api_key)
    return {
        "ok": True,
        "text": result.get("text", ""),
        "model": result.get("model", model),
        "endpoint": result.get("endpoint", endpoint),
        "usage": result.get("usage"),
        "teacher_mode": result.get("teacher_mode", "regex"),
    }

def _assistant_model_fallback_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    if payload.get("disable_model_fallback"):
        return None
    primary_backend = str(payload.get("backend") or DEFAULT_ASSISTANT_BACKEND).strip()
    primary_endpoint = str(payload.get("endpoint") or DEFAULT_ASSISTANT_ENDPOINT).strip().rstrip("/")
    primary_model = str(payload.get("model") or DEFAULT_ASSISTANT_MODEL).strip()
    backend = str(payload.get("fallback_backend") or DEFAULT_ASSISTANT_FALLBACK_BACKEND).strip()
    model = str(payload.get("fallback_model") or DEFAULT_ASSISTANT_FALLBACK_MODEL).strip()
    endpoint = str(payload.get("fallback_model_endpoint") or primary_endpoint).strip().rstrip("/")
    if not backend or not endpoint or not model or (backend, endpoint, model) == (primary_backend, primary_endpoint, primary_model):
        return None
    fallback = dict(payload)
    fallback.update(
        {
            "backend": backend,
            "endpoint": endpoint,
            "model": model,
            "api_key": str(payload.get("fallback_api_key") or payload.get("api_key") or "").strip(),
            "disable_model_fallback": True,
        }
    )
    return fallback


def _prompt_assistant_chat_once(payload: dict[str, Any]) -> dict[str, Any]:
    backend = str(payload.get("backend") or DEFAULT_ASSISTANT_BACKEND).strip()
    if backend == "local-qwen-once":
        return _prompt_assistant_chat_local_once(payload)
    if backend == "local-lmcpp":
        endpoint = str(payload.get("local_endpoint") or DEFAULT_LOCAL_ASSISTANT_ENDPOINT).strip().rstrip("/")
        model = str(payload.get("local_model") or DEFAULT_LOCAL_ASSISTANT_MODEL).strip()
        api_key = ""
    else:
        endpoint = str(payload.get("endpoint") or DEFAULT_ASSISTANT_ENDPOINT).strip().rstrip("/")
        model = str(payload.get("model") or DEFAULT_ASSISTANT_MODEL).strip()
        api_key = _assistant_api_key(payload, backend)
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        raise RuntimeError("messages must be a list")
    if not endpoint:
        raise RuntimeError("OpenAI-compatible endpoint is empty")
    if not model:
        raise RuntimeError("model is empty")
    if _assistant_use_gemini_native(backend, endpoint, model):
        return _prompt_assistant_chat_gemini(payload, endpoint, model, api_key)
    url = _assistant_chat_url(endpoint)

    disable_tools = _payload_bool(payload.get("disable_tools"), False)
    request_messages = _assistant_request_messages(messages, disable_tools)

    body = {
        "model": model,
        "messages": request_messages,
        "temperature": float(payload.get("temperature") or 0.35),
        "top_p": float(payload.get("top_p") or 0.9),
        "max_tokens": int(payload.get("max_tokens") or 8192),
        "stream": False,
    }
    if backend != "local-lmcpp" and not disable_tools:
        body["tools"] = ASSISTANT_TOOLS
        body["tool_choice"] = "auto"
    if urllib.parse.urlparse(endpoint).netloc.lower() == "api.deepseek.com":
        body["thinking"] = {"type": "enabled"}
        body["reasoning_effort"] = str(payload.get("reasoning_effort") or "low")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    response = requests.post(url, json=body, headers=headers, timeout=int(payload.get("timeout") or 120))
    if response.status_code >= 400:
        detail = response.text.strip()
        raise RuntimeError(f"Assistant API {response.status_code} error from {url}: {detail or response.reason}")
    data = response.json()
    message = data["choices"][0]["message"]
    tool_calls = _extract_tool_calls(message)
    if tool_calls:
        text = _clean_response_text(message.get("content", ""))
    else:
        text = _extract_message_text(message)
    return {"text": text, "tool_calls": tool_calls, "model": model, "endpoint": endpoint}


def prompt_assistant_chat(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return _prompt_assistant_chat_once(payload)
    except Exception as primary_error:
        fallback = _assistant_model_fallback_payload(payload)
        if fallback is None:
            raise
        try:
            result = _prompt_assistant_chat_once(fallback)
        except Exception as fallback_error:
            raise RuntimeError(f"Primary assistant failed: {primary_error}; fallback failed: {fallback_error}") from fallback_error
        result.update(
            {
                "fallback_used": True,
                "primary_backend": str(payload.get("backend") or DEFAULT_ASSISTANT_BACKEND),
                "primary_model": str(payload.get("model") or DEFAULT_ASSISTANT_MODEL),
                "primary_error": str(primary_error),
            }
        )
        return result


def _prompt_assistant_stream_once(payload: dict[str, Any]):
    backend = str(payload.get("backend") or DEFAULT_ASSISTANT_BACKEND).strip()
    if backend == "local-qwen-once":
        try:
            yield _assistant_stream_event("done", _prompt_assistant_chat_local_once(payload))
        except Exception as exc:  # noqa: BLE001
            yield _assistant_stream_event("error", {"error": str(exc)})
        return
    if backend == "local-lmcpp":
        endpoint = str(payload.get("local_endpoint") or DEFAULT_LOCAL_ASSISTANT_ENDPOINT).strip().rstrip("/")
        model = str(payload.get("local_model") or DEFAULT_LOCAL_ASSISTANT_MODEL).strip()
        api_key = ""
    else:
        endpoint = str(payload.get("endpoint") or DEFAULT_ASSISTANT_ENDPOINT).strip().rstrip("/")
        model = str(payload.get("model") or DEFAULT_ASSISTANT_MODEL).strip()
        api_key = _assistant_api_key(payload, backend)
    if _assistant_use_gemini_native(backend, endpoint, model):
        yield from _prompt_assistant_stream_gemini(payload, endpoint, model, api_key)
        return
    try:
        result = _prompt_assistant_chat_once(payload)
        yield _assistant_stream_event("done", result)
    except Exception as exc:  # noqa: BLE001
        yield _assistant_stream_event("error", {"error": str(exc)})


def prompt_assistant_stream(payload: dict[str, Any]):
    emitted_content = False
    primary_error = ""
    primary_error_event = ""
    for raw_event in _prompt_assistant_stream_once(payload):
        try:
            event = json.loads(raw_event)
        except (TypeError, json.JSONDecodeError):
            event = {}
        if event.get("type") == "error" and not emitted_content:
            primary_error = str(event.get("error") or "assistant stream failed")
            primary_error_event = raw_event
            break
        if event.get("type") == "done" or (event.get("type") == "delta" and event.get("text")):
            emitted_content = True
        yield raw_event
    if not primary_error:
        return
    fallback = _assistant_model_fallback_payload(payload)
    if fallback is None:
        yield primary_error_event
        return
    yield _assistant_stream_event(
        "fallback",
        {
            "fallback_used": True,
            "primary_backend": str(payload.get("backend") or DEFAULT_ASSISTANT_BACKEND),
            "primary_model": str(payload.get("model") or DEFAULT_ASSISTANT_MODEL),
            "primary_error": primary_error,
            "backend": fallback["backend"],
            "model": fallback["model"],
        },
    )
    yield from _prompt_assistant_stream_once(fallback)


def _assistant_api_key(payload: dict[str, Any], backend: str) -> str:
    explicit = str(payload.get("api_key") or "").strip()
    if explicit:
        return explicit
    names = ["DEEPSEEK_API_KEY"] if backend == "deepseek" else ["Q3VL_MOYUU_API_KEY", "MOYUU_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""
