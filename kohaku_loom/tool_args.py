from __future__ import annotations

import json
from typing import Any


def unwrap_object_content(arguments: dict[str, Any]) -> dict[str, Any]:
    """Recover structured arguments accidentally nested in ``content``."""
    normalized = dict(arguments) if isinstance(arguments, dict) else {}
    content = normalized.get("content")
    if not isinstance(content, str):
        return normalized
    try:
        decoded = json.loads(content)
    except (TypeError, ValueError):
        return normalized
    if not isinstance(decoded, dict):
        return normalized
    normalized.pop("content", None)
    normalized.update(decoded)
    return normalized
