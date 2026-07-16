from __future__ import annotations

import inspect
import time
from typing import Any, Callable

from kohaku_loom.sidecar.session_metadata import (
    normalize_branch_view,
    read_metadata,
    serialize_branch_view,
    write_metadata,
)


def _native_history() -> tuple[Callable, Callable, Callable, Callable, Callable]:
    from kohakuterrarium.session.history import (
        _index_parent_paths,
        _resolve_selected_branches,
        collect_branch_metadata,
        replay_conversation,
        select_live_event_ids,
    )

    return (
        _index_parent_paths,
        _resolve_selected_branches,
        collect_branch_metadata,
        replay_conversation,
        select_live_event_ids,
    )


def _events(session: Any) -> list[dict[str, Any]]:
    agent = session.creature.agent
    store = getattr(agent, "session_store", None)
    name = str(getattr(getattr(agent, "config", None), "name", "") or "")
    getter = getattr(store, "get_events", None)
    if store is None or not callable(getter) or not name:
        raise RuntimeError("KohakuTerrarium session history is unavailable")
    result = getter(name)
    return [dict(event) for event in result] if isinstance(result, list) else []


def _selected_ids(
    events: list[dict[str, Any]],
    view: dict[int, int],
    history: tuple[Callable, Callable, Callable, Callable, Callable],
) -> dict[int, int]:
    index_parent_paths, resolve_selected, _collect, _replay, select_live = history
    try:
        return dict(resolve_selected(events, index_parent_paths(events), view or None))
    except Exception:
        live_ids = select_live(events, branch_view=view or None)
        selected: dict[int, int] = {}
        for event in events:
            if event.get("event_id") not in live_ids:
                continue
            turn_index = event.get("turn_index")
            branch_id = event.get("branch_id")
            if isinstance(turn_index, int) and isinstance(branch_id, int):
                selected[turn_index] = branch_id
        return selected


def _branch_statuses(events: list[dict[str, Any]]) -> dict[tuple[int, int], str]:
    interrupted_types = {
        "activity:interrupt",
        "interrupt",
        "cancelled",
        "activity:cancelled",
    }
    failed_types = {
        "processing_error",
        "activity:processing_error",
        "turn_error",
        "error",
    }
    grouped: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for event in events:
        turn_index = event.get("turn_index")
        branch_id = event.get("branch_id")
        if isinstance(turn_index, int) and isinstance(branch_id, int):
            grouped.setdefault((turn_index, branch_id), []).append(event)
    result: dict[tuple[int, int], str] = {}
    for pair, branch_events in grouped.items():
        # Tool/sub-agent failures are recoverable inside a completed turn;
        # only native turn-level terminal events classify the branch.
        interrupted = any(event.get("type") in interrupted_types for event in branch_events)
        failed = any(event.get("type") in failed_types for event in branch_events)
        complete = any(event.get("type") == "processing_end" for event in branch_events)
        result[pair] = "cancelled" if interrupted else "failed" if failed else "completed" if complete else "incomplete"
    return result


def _payload(session_id: str, session: Any, events: list[dict[str, Any]], view: dict[int, int]) -> dict[str, Any]:
    history = _native_history()
    _index_parent_paths, _resolve_selected, collect, _replay, _select_live = history
    selected = _selected_ids(events, view, history)
    metadata = collect(events, branch_view=view or None)
    statuses = _branch_statuses(events)
    turns: list[dict[str, Any]] = []
    branch_counts: dict[int, int] = {}
    latest_ids: dict[int, int] = {}
    branch_statuses: dict[int, dict[int, str]] = {}
    for turn_index, info in sorted(metadata.items()):
        branches = [int(branch) for branch in info.get("branches", [])]
        branch_counts[turn_index] = len(branches)
        latest_ids[turn_index] = int(info.get("latest_branch") or 0)
        states = {branch: statuses.get((turn_index, branch), "incomplete") for branch in branches}
        branch_statuses[turn_index] = states
        turns.append(
            {
                "turn_index": turn_index,
                "branches": branches,
                "branch_count": len(branches),
                "latest_branch": latest_ids[turn_index],
                "selected_branch_id": selected.get(turn_index),
                "branch_statuses": states,
                "events_by_branch": info.get("events_by_branch", {}),
            }
        )
    return {
        "session_id": session_id,
        "branch_view": dict(view),
        "selected_branch_ids": selected,
        "branch_counts": branch_counts,
        "latest_branch_ids": latest_ids,
        "branch_statuses": branch_statuses,
        "turns": turns,
        "final_turn_index": max(selected) if selected else None,
    }


def _validate_view(events: list[dict[str, Any]], view: dict[int, int]) -> None:
    selected = _selected_ids(events, view, _native_history())
    for turn_index, branch_id in view.items():
        if selected.get(turn_index) != branch_id:
            raise ValueError(f"branch_view selects unavailable branch {turn_index}:{branch_id}")


def _replay_agent(agent: Any, events: list[dict[str, Any]], view: dict[int, int]) -> None:
    reload_view = getattr(agent, "_reload_conversation_under_branch_view", None)
    if not callable(reload_view):
        raise RuntimeError("KohakuTerrarium native branch replay is unavailable")
    result = reload_view(dict(view))
    if inspect.isawaitable(result):
        raise RuntimeError("KohakuTerrarium branch replay must be synchronous")
    agent._branch_view = dict(view)


def _persist(runtime: Any, session: Any, view: dict[int, int]) -> None:
    path = session.path
    value = read_metadata(path)
    value.update(
        {
            "version": int(value.get("version") or 1),
            "session_id": session.session_id,
            "branch_view": serialize_branch_view(view),
            "updated_at": time.time(),
        }
    )
    write_metadata(path, value)
    session.branch_view = dict(view)


def _assert_idle(runtime: Any, session: Any) -> None:
    if runtime.has_active_turn:
        raise RuntimeError("Branch operations require an idle Loom turn")
    agent = session.creature.agent
    processing_task = getattr(agent, "_processing_task", None)
    if processing_task is not None:
        done = getattr(processing_task, "done", None)
        if callable(done) and not done():
            raise RuntimeError("Branch operations require an idle Loom turn")
    processing_lock = getattr(agent, "_processing_lock", None)
    if processing_lock is not None:
        locked = getattr(processing_lock, "locked", None)
        if callable(locked) and locked():
            raise RuntimeError("Branch operations require an idle Loom turn")
    queue = runtime._queue(session)
    if queue.active():
        raise RuntimeError("Branch operations require no pending or guide queue")


def _load_view(session: Any) -> dict[int, int]:
    value = getattr(session, "branch_view", None)
    if isinstance(value, dict):
        return normalize_branch_view(value)
    path = getattr(session, "path", None)
    if not hasattr(path, "is_file"):
        return {}
    value = read_metadata(path).get("branch_view")
    return normalize_branch_view(value)


def restore(runtime: Any, session: Any) -> dict[str, Any]:
    view = normalize_branch_view(read_metadata(session.path).get("branch_view"))
    try:
        events = _events(session)
        _validate_view(events, view)
        _replay_agent(session.creature.agent, events, view)
    except (ImportError, ModuleNotFoundError, RuntimeError):
        # A test double or an old sidecar may not expose native history. The
        # persisted selection is still retained and will be replayed later.
        session.branch_view = dict(view)
        return _payload_without_native(session.session_id, view)
    except ValueError:
        view = {}
        events = _events(session)
        _replay_agent(session.creature.agent, events, view)
        _persist(runtime, session, view)
    session.branch_view = dict(view)
    return _payload(session.session_id, session, events, view)


def _payload_without_native(session_id: str, view: dict[int, int]) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "branch_view": dict(view),
        "selected_branch_ids": {},
        "branch_counts": {},
        "latest_branch_ids": {},
        "branch_statuses": {},
        "turns": [],
        "final_turn_index": None,
    }


def metadata(runtime: Any, session_id: str) -> dict[str, Any]:
    session = runtime._active_session(session_id)
    view = _load_view(session)
    try:
        return _payload(session_id, session, _events(session), view)
    except (ImportError, ModuleNotFoundError, RuntimeError):
        return _payload_without_native(session_id, view)


async def select(runtime: Any, session_id: str, raw_view: Any) -> dict[str, Any]:
    async with runtime._lock:
        session = runtime._active_session(session_id)
        _assert_idle(runtime, session)
        view = normalize_branch_view(raw_view, strict=True)
        events = _events(session)
        _validate_view(events, view)
        _replay_agent(session.creature.agent, events, view)
        _persist(runtime, session, view)
        payload = _payload(session_id, session, events, view)
        await runtime.events.publish("branch_view_changed", payload)
        return payload


async def replay(runtime: Any, session_id: str, raw_view: Any = None) -> dict[str, Any]:
    async with runtime._lock:
        session = runtime._active_session(session_id)
        _assert_idle(runtime, session)
        view = _load_view(session) if raw_view is None else normalize_branch_view(raw_view, strict=True)
        events = _events(session)
        _validate_view(events, view)
        _replay_agent(session.creature.agent, events, view)
        if raw_view is not None:
            _persist(runtime, session, view)
        return runtime.session_conversation(session_id)


def _completed_final_response(events: list[dict[str, Any]], view: dict[int, int]) -> bool:
    history = _native_history()
    _index_parent_paths, _resolve_selected, _collect, replay, select_live = history
    selected = _selected_ids(events, view, history)
    if not selected:
        return False
    final_turn = max(selected)
    branch_status = _branch_statuses(events).get((final_turn, selected[final_turn]))
    if branch_status != "completed":
        return False
    messages = replay(events, branch_view=view or None)
    last_user = max((index for index, message in enumerate(messages) if message.get("role") == "user"), default=-1)
    return any(
        message.get("role") == "assistant"
        and (bool(message.get("content")) or bool(message.get("tool_calls")))
        for message in messages[last_user + 1 :]
    )


async def regenerate(runtime: Any, session_id: str) -> dict[str, Any]:
    async with runtime._lock:
        session = runtime._active_session(session_id)
        _assert_idle(runtime, session)
        view = _load_view(session)
        events = _events(session)
        _validate_view(events, view)
        if not _completed_final_response(events, view):
            raise RuntimeError("Only the final completed assistant response can be regenerated")
        _replay_agent(session.creature.agent, events, view)
        await runtime.events.publish(
            "branch_regeneration_started",
            {"session_id": session_id, "branch_view": dict(view)},
        )
        result = await _native_regenerate(session, view)
        events = _events(session)
        turn_index = result.get("turn_index") if isinstance(result, dict) else None
        branch_id = result.get("branch_id") if isinstance(result, dict) else None
        if not isinstance(turn_index, int):
            turn_index = getattr(session.creature.agent, "_turn_index", None)
        if not isinstance(branch_id, int):
            branch_id = getattr(session.creature.agent, "_branch_id", None)
        next_view = dict(view)
        if isinstance(turn_index, int) and isinstance(branch_id, int) and turn_index > 0 and branch_id > 0:
            next_view = {turn: branch for turn, branch in view.items() if turn <= turn_index}
            next_view[turn_index] = branch_id
            try:
                _validate_view(events, next_view)
            except ValueError:
                next_view = dict(view)
        _replay_agent(session.creature.agent, events, next_view)
        _persist(runtime, session, next_view)
        payload = _payload(session_id, session, events, next_view)
        payload.update(
            {
                "status": str(result.get("status") or "regenerating") if isinstance(result, dict) else "regenerating",
                "turn_index": turn_index,
                "branch_id": branch_id,
            }
        )
        if isinstance(turn_index, int) and isinstance(branch_id, int):
            payload["branch_status"] = _branch_statuses(events).get((turn_index, branch_id), "incomplete")
        await runtime.events.publish("branch_regeneration_finished", payload)
        return payload


async def _native_regenerate(session: Any, view: dict[int, int]) -> dict[str, Any]:
    from kohakuterrarium.terrarium.service import LocalTerrariumService

    creature_id = str(getattr(session.creature, "creature_id", "") or "loom")
    service = LocalTerrariumService(session.engine)
    result = await service.regenerate(creature_id, turn_index=None, branch_view=dict(view))
    return dict(result) if isinstance(result, dict) else {"status": "regenerating"}
