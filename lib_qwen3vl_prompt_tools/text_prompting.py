from __future__ import annotations

import gc
import re
import subprocess
from typing import Any

import requests
from PIL import Image

from .constants import NL_PROMPT_TEMPLATES
from .image_payloads import _image_data_url
from .llama_runtime import _free_port, _post_local_chat, _wait_server
from .model_paths import ensure_local_gguf_pair, resolve_llama_server
from .response_text import _extract_message_text

def _nl_messages(tags: str, characters: str, rating: str, guidance: str, language: str, prompt_template: str):
    if not tags.strip() and not characters.strip():
        raise RuntimeError("请先生成 tags，或手动填入 tags。")
    template = NL_PROMPT_TEMPLATES.get(prompt_template, "standard")
    if template != "standard":
        system_prompt = (
            "You are a precise image-prompt specialist. Follow the user's template exactly. "
            "Do not output analysis, markdown, labels, or reasoning. Remove the source subject completely."
        )
        user_prompt = (
            f"{template}\n\n"
            "Tag hints extracted from the image:\n"
            f"Rating tag: {rating or 'unknown'}\n"
            f"Character tags: {characters or 'none'}\n"
            f"General tags: {tags}\n"
        )
        if guidance.strip():
            user_prompt += f"\n额外要求（必须遵守，优先级最高）：{guidance.strip()}\n"
        return [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

    system_prompt = (
        "You convert Danbooru-style image tags into one natural-language image prompt. "
        "Return only the prompt. Do not add markdown, labels, commentary, reasoning, or analysis. "
        "Preserve visible subjects, composition, lighting, materials, style, and mood implied by the tags. "
        "Do not invent identities, artists, copyrighted titles, or details not supported by the tags. "
        "Any additional user direction is mandatory and overrides the default style."
    )
    user_prompt = (
        f"Output language: {language}\n"
        f"Rating tag: {rating or 'unknown'}\n"
        f"Character tags: {characters or 'none'}\n"
        f"General tags: {tags}\n"
    )
    if guidance.strip():
        user_prompt += f"Mandatory additional direction: {guidance.strip()}\n"
    user_prompt += "\nReturn one fluent natural-language prompt."
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def build_nl_from_endpoint(
    tags: str,
    characters: str,
    rating: str,
    guidance: str,
    image: Image.Image | None,
    prompt_template: str,
    endpoint: str,
    model: str,
    language: str,
    max_tokens: int,
    temperature: float,
    top_p: float,
    timeout: int,
    enable_thinking: bool,
) -> str:
    endpoint = endpoint.strip().rstrip("/")
    if not endpoint:
        raise RuntimeError("请填写 llama.cpp/OpenAI-compatible endpoint。")
    if endpoint.endswith("/chat/completions"):
        url = endpoint
    elif endpoint.endswith("/v1"):
        url = endpoint + "/chat/completions"
    else:
        url = endpoint + "/v1/chat/completions"

    payload: dict[str, Any] = {
        "messages": _prompt_messages(tags, characters, rating, guidance, image, language, prompt_template),
        "temperature": float(temperature),
        "top_p": float(top_p),
        "max_tokens": int(max_tokens),
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": bool(enable_thinking)},
    }
    if model.strip():
        payload["model"] = model.strip()

    response = requests.post(url, json=payload, timeout=int(timeout))
    response.raise_for_status()
    return _postprocess_prompt(_extract_message_text(response.json()["choices"][0]["message"]), prompt_template)
def build_nl_from_local_gguf(
    tags: str,
    characters: str,
    rating: str,
    guidance: str,
    image: Image.Image | None,
    prompt_template: str,
    model_path: str,
    mmproj_path: str,
    llama_server_path: str,
    language: str,
    max_tokens: int,
    temperature: float,
    top_p: float,
    n_ctx: int,
    n_gpu_layers: int,
    chat_format: str,
    timeout: int,
    enable_thinking: bool,
) -> str:
    model_path, mmproj_path = ensure_local_gguf_pair(model_path, mmproj_path, image is not None)

    llama_server_path = resolve_llama_server(llama_server_path)

    port = _free_port()
    proc: subprocess.Popen | None = None
    try:
        args = [
            llama_server_path,
            "-m",
            model_path,
            "-ngl",
            "all" if int(n_gpu_layers) < 0 else str(int(n_gpu_layers)),
            "-c",
            str(int(n_ctx)),
            "-fa",
            "on",
            "-np",
            "1",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--alias",
            "local-gguf-once",
            "--jinja",
        ]
        if mmproj_path:
            args[3:3] = ["-mm", mmproj_path]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
        endpoint = f"http://127.0.0.1:{port}/v1"
        _wait_server(endpoint, int(timeout))
        response = _post_local_chat(
            endpoint,
            _prompt_messages(tags, characters, rating, guidance, image, language, prompt_template),
            max_tokens,
            temperature,
            top_p,
            int(timeout),
            bool(enable_thinking),
        )
        return _postprocess_prompt(_extract_message_text(response["choices"][0]["message"]), prompt_template)
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        gc.collect()
def _postprocess_prompt(text: str, prompt_template: str) -> str:
    if NL_PROMPT_TEMPLATES.get(prompt_template, "standard") == "standard":
        return text
    placeholder = "[replace with your desired subject here]"
    cleaned = text
    cleaned = re.sub(r"\[(?:replace|insert).*?subject.*?\]", placeholder, cleaned, flags=re.IGNORECASE)
    subject_patterns = [
        r"\b(?:anthropomorphic|furry)\s+(?:wolf|fox|dog|cat|tiger|dragon|animal)\s+(?:boy|girl|man|woman|character)\b",
        r"\b(?:wolf|fox|dog|cat|tiger|dragon)\s+(?:boy|girl|man|woman|character)\b",
        r"\b(?:anime|manga)\s+(?:boy|girl|man|woman|character)\b",
        r"\b(?:boy|girl|man|woman|character|person|figure)\s+(?:with|wearing|holding)\b[^,;.]*",
        r"\bwearing\s+(?:a\s+)?(?:white\s+)?(?:collared\s+)?shirt\b[^,;.]*",
        r"\b(?:necktie|tie|shirt|collar|sweater|jacket)\b",
        r"\b(?:wolf|fox|dog|cat|tiger|dragon|animal ears|blue eyes|fur|snout|tail|sweat drop)\b",
    ]
    for pattern in subject_patterns:
        cleaned = re.sub(pattern, placeholder, cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(rf"(?:{re.escape(placeholder)}\s*,\s*)+", f"{placeholder}, ", cleaned)
    cleaned = re.sub(rf"(?:{re.escape(placeholder)}\s+)+", f"{placeholder} ", cleaned)
    if placeholder not in cleaned:
        cleaned = f"{placeholder}, {cleaned}"
    return " ".join(cleaned.split()).strip()


def _prompt_messages(
    tags: str,
    characters: str,
    rating: str,
    guidance: str,
    image: Image.Image | None,
    language: str,
    prompt_template: str,
) -> list[dict[str, Any]]:
    if image is None:
        return _nl_messages(tags, characters, rating, guidance, language, prompt_template)

    template = NL_PROMPT_TEMPLATES.get(prompt_template, "standard")
    if template != "standard":
        system_prompt = (
            "You are a top-tier AI image-prompt specialist. Follow the user's template exactly. "
            "Use the image as the primary source for style only. Remove the source subject completely. "
            "Do not output analysis, markdown, labels, or reasoning."
        )
        user_text = (
            f"{template}\n\n"
            "Style-only tag hints. Use these only to infer aesthetics; do not copy subject nouns into the output:\n"
            f"Rating tag hint: {rating or 'unknown'}\n"
            f"Character tag hints: {characters or 'none'}\n"
            f"General tag hints: {tags or 'none'}\n"
        )
        if guidance.strip():
            user_text += f"\n额外要求（必须遵守，优先级最高）：{guidance.strip()}\n"
        return [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": _image_data_url(image)}},
                ],
            },
        ]

    system_prompt = (
        "You are a visual prompt editor. Return only one faithful natural-language image prompt, "
        "with no labels, markdown, quotation marks, reasoning, or analysis. "
        "Any additional user direction is mandatory and overrides the default style."
    )
    user_text = (
        "Describe the provided image as a production-ready text-to-image prompt. "
        "Trust the image over the tag hints. Cover subject, pose, composition, lighting, palette, style, and visible text. "
        "Do not invent identities or facts that are not visible.\n\n"
        f"Output language: {language}\n"
        f"Rating tag hint: {rating or 'unknown'}\n"
        f"Character tag hints: {characters or 'none'}\n"
        f"General tag hints: {tags or 'none'}\n"
    )
    if guidance.strip():
        user_text += f"Mandatory additional direction: {guidance.strip()}\n"
    return [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": _image_data_url(image)}},
            ],
        },
    ]
def combine_prompt(tags: str, nl: str, mode: str) -> str:
    tags = tags.strip()
    nl = nl.strip()
    if mode == "Tags only":
        return tags
    if mode == "NL only":
        return nl
    if tags and nl:
        return f"{tags}\n\n{_strip_subject_placeholders(nl)}"
    return tags or nl


def _strip_subject_placeholders(text: str) -> str:
    text = re.sub(r"\[[^\]]*(?:replace|insert|subject|character|主体|角色)[^\]]*\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    text = re.sub(r"^[\s,.;:]+", "", text)
    return " ".join(text.split()).strip()
