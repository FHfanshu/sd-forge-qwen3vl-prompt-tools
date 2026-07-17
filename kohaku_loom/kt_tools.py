from __future__ import annotations

import asyncio
import json
from typing import Any

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult

from .danbooru import (
    inspect_danbooru_tag,
    inspect_danbooru_tags,
    related_danbooru_tags,
    search_danbooru_tags,
)
from .prompt_skills import load_prompt_skill
from .tool_args import unwrap_object_content


def _compat_danbooru_arguments(args: dict[str, Any]) -> dict[str, Any]:
    normalized = unwrap_object_content(args)
    if normalized.get("action"):
        return normalized

    content = str(normalized.get("content") or "").strip()
    if not content:
        return normalized
    command, _, query = content.partition(" ")
    command = command.lower()
    query = query.strip()
    if command in {"search", "find", "lookup"} and query:
        normalized.update({"action": "search", "query": query})
    elif command == "inspect" and query and "," not in query:
        normalized.update({"action": "inspect", "name": query})
    elif command == "related" and query:
        normalized.update({"action": "related", "name": query})
    else:
        normalized.update({"action": "search", "query": query or content})
    return normalized


class DanbooruTool(BaseTool):
    @property
    def tool_name(self) -> str:
        return "danbooru"

    @property
    def description(self) -> str:
        return "Search, inspect, batch-inspect, or find related canonical Danbooru tags."

    @property
    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode.DIRECT

    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["search", "inspect", "inspect_batch", "related"],
            },
            "query": {"type": "string"},
            "queries": {"type": "array", "items": {"type": "string"}},
            "name": {"type": "string"},
            "names": {"type": "array", "items": {"type": "string"}},
            "category": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            "include_wiki": {"type": "boolean"},
        },
        "required": ["action"],
    }

    async def _execute(self, args: dict[str, Any], **_: Any) -> ToolResult:
        args = _compat_danbooru_arguments(args)
        action = str(args.get("action") or "").strip()
        try:
            if action == "search":
                value = await asyncio.to_thread(
                    search_danbooru_tags,
                    str(args.get("query") or ""),
                    str(args.get("category") or ""),
                    int(args.get("limit") or 12),
                    args.get("queries"),
                )
            elif action == "inspect":
                value = await asyncio.to_thread(
                    inspect_danbooru_tag,
                    str(args.get("name") or ""),
                    bool(args.get("include_wiki", True)),
                )
            elif action == "inspect_batch":
                value = await asyncio.to_thread(
                    inspect_danbooru_tags,
                    args.get("names"),
                    bool(args.get("include_wiki", False)),
                )
            elif action == "related":
                value = await asyncio.to_thread(
                    related_danbooru_tags,
                    str(args.get("name") or ""),
                    str(args.get("category") or ""),
                    int(args.get("limit") or 12),
                )
            else:
                return ToolResult(output="Unsupported Danbooru action.", error="unsupported_action")
            return ToolResult(output=json.dumps(value, ensure_ascii=False))
        except Exception as error:
            return ToolResult(output=str(error), error=type(error).__name__)


class PromptSkillTool(BaseTool):
    @property
    def tool_name(self) -> str:
        return "load_prompt_skill"

    @property
    def description(self) -> str:
        return "Load a named prompt-engineering skill reference for the current task."

    @property
    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode.DIRECT

    parameters = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
        },
        "required": ["name"],
    }

    async def _execute(self, args: dict[str, Any], **_: Any) -> ToolResult:
        try:
            value = await asyncio.to_thread(load_prompt_skill, str(args.get("name") or ""))
            output = json.dumps(value, ensure_ascii=False)
            if isinstance(value, dict) and value.get("ok") is False:
                return ToolResult(output=output, error=str(value.get("error") or "prompt_skill_unavailable"))
            return ToolResult(output=output)
        except Exception as error:
            return ToolResult(output=str(error), error=type(error).__name__)
