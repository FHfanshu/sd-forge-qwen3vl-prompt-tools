from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator, Callable


class RuntimeEventLog:
    def __init__(self, limit: int = 2000, on_publish: Callable[[], None] | None = None):
        self._limit = max(20, limit)
        self._on_publish = on_publish
        self._events: list[dict[str, Any]] = []
        self._condition = asyncio.Condition()
        self._sequence = 0

    @property
    def sequence(self) -> int:
        return self._sequence

    async def publish(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._sequence += 1
        event = {
            "sequence": self._sequence,
            "type": event_type,
            "created_at": time.time(),
            "payload": json.loads(json.dumps(payload, ensure_ascii=False, default=str)),
        }
        self._events.append(event)
        if len(self._events) > self._limit:
            del self._events[: len(self._events) - self._limit]
        if self._on_publish is not None:
            self._on_publish()
        async with self._condition:
            self._condition.notify_all()
        return event

    def after(self, sequence: int) -> list[dict[str, Any]]:
        return [dict(event) for event in self._events if int(event["sequence"]) > int(sequence)]

    async def subscribe(self, sequence: int = 0, keepalive: float = 15.0) -> AsyncIterator[dict[str, Any] | None]:
        cursor = int(sequence)
        while True:
            events = self.after(cursor)
            if events:
                for event in events:
                    cursor = int(event["sequence"])
                    yield event
                continue
            try:
                async with self._condition:
                    await asyncio.wait_for(self._condition.wait(), timeout=max(1.0, keepalive))
            except asyncio.TimeoutError:
                yield None
