from __future__ import annotations

import gc
import subprocess
from typing import Any

from .assistant_common import _assistant_request_messages, _extract_tool_calls
from .constants import DEFAULT_LOCAL_TEXT_PRESET
from .llama_runtime import _free_port, _post_local_chat, _wait_server
from .model_paths import resolve_llama_server, resolve_vision_model_pair
from .response_text import _clean_response_text, _extract_message_text

def _prompt_assistant_chat_local_once(payload: dict[str, Any]) -> dict[str, Any]:
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        raise RuntimeError("messages must be a list")
    request_messages = _assistant_request_messages(messages)
    preset = str(payload.get("local_text_preset") or DEFAULT_LOCAL_TEXT_PRESET).strip()
    model_path, _mmproj_path, alias = resolve_vision_model_pair(preset, str(payload.get("local_model_path") or ""), "", False)
    llama_server_path = resolve_llama_server(str(payload.get("llama_server_path") or ""))
    port = _free_port()
    proc: subprocess.Popen | None = None
    timeout = int(payload.get("timeout") or 120)
    try:
        n_gpu_layers = payload.get("local_n_gpu_layers", payload.get("n_gpu_layers", "all"))
        args = [
            llama_server_path,
            "-m",
            model_path,
            "-ngl",
            "all" if str(n_gpu_layers).strip() in {"", "-1", "all"} else str(int(n_gpu_layers)),
            "-c",
            str(int(payload.get("local_n_ctx") or payload.get("n_ctx") or 8192)),
            "-fa",
            "on",
            "-np",
            "1",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--alias",
            alias,
            "--jinja",
        ]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
        endpoint = f"http://127.0.0.1:{port}/v1"
        _wait_server(endpoint, timeout)
        response = _post_local_chat(
            endpoint,
            request_messages,
            int(payload.get("max_tokens") or 2048),
            float(payload.get("temperature") or 0.25),
            float(payload.get("top_p") or 0.9),
            timeout,
            False,
            alias,
        )
        message = response["choices"][0]["message"]
        tool_calls = _extract_tool_calls(message)
        text = _clean_response_text(message.get("content", "")) if tool_calls else _extract_message_text(message)
        return {"text": text, "tool_calls": tool_calls, "model": alias, "endpoint": endpoint, "source": "one-shot-local-qwen"}
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        gc.collect()
