from __future__ import annotations

import functools
import json
import os
import re
import unittest
from pathlib import Path
from typing import Any, Callable, TypeVar


ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = ROOT / "quality" / "acceptance.json"
REFERENCE_RE = re.compile(r"^(?P<id>[A-Z][A-Z0-9-]*-\d{3})@(?P<revision>[1-9]\d*)$")
F = TypeVar("F", bound=Callable[..., Any])


def _registry() -> dict[str, int]:
    payload = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {item["id"]: item["revision"] for item in payload["requirements"]}


def _reference_status(reference: str) -> tuple[bool, str]:
    match = REFERENCE_RE.fullmatch(reference)
    if not match:
        return False, f"invalid acceptance reference: {reference}"
    current = _registry().get(match.group("id"))
    revision = int(match.group("revision"))
    if current is None:
        return False, f"unknown acceptance requirement: {reference}"
    if current != revision:
        return False, f"stale acceptance reference: {reference}; current revision is {current}"
    return True, ""


def acceptance(reference: str, scenarios: str) -> Callable[[F], F]:
    """Attach current acceptance metadata to a critical unittest."""

    def decorate(function: F) -> F:
        setattr(function, "__acceptance_reference__", reference)
        setattr(function, "__acceptance_scenarios__", tuple(_scenario_values(scenarios)))
        current, message = _reference_status(reference)
        if current:
            return function
        if os.environ.get("PROMPT_AGENT_TEST_MODE") == "affected":
            return unittest.skip(f"ACCEPTANCE WARNING: {message}")(function)  # type: ignore[return-value]

        @functools.wraps(function)
        def stale(*args: Any, **kwargs: Any) -> Any:
            raise AssertionError(f"ACCEPTANCE STALE: {message}")

        setattr(stale, "__acceptance_reference__", reference)
        setattr(stale, "__acceptance_scenarios__", tuple(_scenario_values(scenarios)))
        return stale  # type: ignore[return-value]

    return decorate


def _scenario_values(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]
