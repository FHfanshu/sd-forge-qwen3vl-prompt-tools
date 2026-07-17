from __future__ import annotations

import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from kohaku_loom.runtime_paths import LoomRuntimePaths
from kohaku_loom.sidecar import branch_runtime
from kohaku_loom.sidecar.app import create_app
from kohaku_loom.sidecar.message_queue import LoomMessageQueue
from kohaku_loom.sidecar.session_metadata import metadata_path, read_metadata
from kohaku_loom.sidecar.runtime import LoomSidecarRuntime


def native_history_fakes():
    def index_parent_paths(events):
        paths = {}
        latest = {}
        for event in events:
            event_id = event.get("event_id")
            turn = event.get("turn_index")
            branch = event.get("branch_id")
            if isinstance(event_id, int):
                paths[event_id] = tuple(
                    sorted((item, value) for item, value in latest.items() if item < turn)
                ) if isinstance(turn, int) else ()
            if isinstance(turn, int) and isinstance(branch, int):
                latest[turn] = max(branch, latest.get(turn, 0))
        return paths

    def resolve(events, paths, view):
        del paths
        branches = {}
        for event in events:
            turn = event.get("turn_index")
            branch = event.get("branch_id")
            if isinstance(turn, int) and isinstance(branch, int):
                branches.setdefault(turn, set()).add(branch)
        selected = {}
        for turn in sorted(branches):
            selected[turn] = int((view or {}).get(turn, max(branches[turn])))
            if selected[turn] not in branches[turn]:
                selected.pop(turn)
        return selected

    def collect(events, *, branch_view=None):
        selected = resolve(list(events), {}, branch_view)
        result = {}
        for event in events:
            turn = event.get("turn_index")
            branch = event.get("branch_id")
            event_id = event.get("event_id")
            if not isinstance(turn, int) or not isinstance(branch, int):
                continue
            info = result.setdefault(
                turn,
                {"branches": [], "latest_branch": 0, "events_by_branch": {}},
            )
            if branch not in info["branches"]:
                info["branches"].append(branch)
                info["events_by_branch"][branch] = []
            if isinstance(event_id, int):
                info["events_by_branch"][branch].append(event_id)
            info["latest_branch"] = max(info["latest_branch"], branch)
        for info in result.values():
            info["branches"].sort()
        return result

    def select_live(events, *, branch_view=None):
        selected = resolve(list(events), {}, branch_view)
        return {
            event["event_id"]
            for event in events
            if isinstance(event.get("event_id"), int)
            and (
                not isinstance(event.get("turn_index"), int)
                or selected.get(event.get("turn_index")) == event.get("branch_id")
            )
        }

    def collect_groups(events, *, branch_view=None):
        meta = collect(events, branch_view=branch_view)
        contents = {}
        for event in events:
            turn = event.get("turn_index")
            branch = event.get("branch_id")
            if event.get("type") == "user_message" and isinstance(turn, int) and isinstance(branch, int):
                contents.setdefault(turn, {}).setdefault(branch, event.get("content", ""))
        selected = resolve(list(events), {}, branch_view)
        result = {}
        for turn, info in meta.items():
            groups = []
            for branch in info["branches"]:
                content = contents.get(turn, {}).get(branch, "")
                group = next((item for item in groups if item["content"] == content), None)
                if group:
                    group["branches"].append(branch)
                else:
                    groups.append({"content": content, "branches": [branch]})
            selected_index = next((index for index, group in enumerate(groups) if selected.get(turn) in group["branches"]), 0)
            result[turn] = {"groups": groups, "selected_group_idx": selected_index}
        return result

    def replay(events, *, branch_view=None):
        selected = resolve(list(events), {}, branch_view)
        messages = []
        for event in events:
            turn = event.get("turn_index")
            branch = event.get("branch_id")
            if isinstance(turn, int) and selected.get(turn) != branch:
                continue
            event_type = event.get("type")
            if event_type == "user_message":
                messages.append({"role": "user", "content": event.get("content", "")})
            elif event_type in {"text_chunk", "text"}:
                if messages and messages[-1].get("role") == "assistant":
                    messages[-1]["content"] += event.get("content", "")
                else:
                    messages.append({"role": "assistant", "content": event.get("content", "")})
        return messages

    return index_parent_paths, resolve, collect, collect_groups, replay, select_live


class BranchFakeStore:
    def __init__(self, events):
        self.events = list(events)
        self.state = {}

    def get_events(self, _agent_name):
        return [dict(event) for event in self.events]

    def append_event(self, *_args, **_kwargs):
        return None


class BranchFakeConversation:
    def __init__(self, messages=None):
        self.messages = list(messages or [])

    def to_messages(self, **_kwargs):
        return list(self.messages)


class BranchFakeAgent:
    def __init__(self, events):
        self.config = mock.Mock(name="loom")
        self.config.name = "loom"
        self.session_store = BranchFakeStore(events)
        self.controller = mock.Mock()
        self.controller.conversation = BranchFakeConversation()
        self.reloads = []
        self._processing_task = None
        self._processing_lock = mock.Mock()
        self._processing_lock.locked.return_value = False
        self._turn_index = 2
        self._branch_id = 1

    def _reload_conversation_under_branch_view(self, view):
        self.reloads.append(dict(view))


class BranchRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.native = mock.patch.object(branch_runtime, "_native_history", return_value=native_history_fakes())
        self.native.start()
        self.addCleanup(self.native.stop)

    def make_runtime(self, root: Path, events):
        paths = LoomRuntimePaths.under(root).ensure()
        runtime = LoomSidecarRuntime(paths, mock.Mock(), mock.Mock())
        session_path = paths.sessions / "session.kohakutr"
        session_path.touch()
        agent = BranchFakeAgent(events)
        session = mock.Mock(
            session_id="session",
            path=session_path,
            creature=mock.Mock(agent=agent, creature_id="loom"),
            engine=mock.Mock(),
            branch_view={},
        )
        runtime.active = session
        return runtime, session, agent

    @staticmethod
    def events():
        return [
            {"event_id": 1, "type": "user_message", "content": "first", "turn_index": 1, "branch_id": 1},
            {"event_id": 2, "type": "text_chunk", "content": "one", "turn_index": 1, "branch_id": 1},
            {"event_id": 3, "type": "processing_end", "turn_index": 1, "branch_id": 1},
            {"event_id": 4, "type": "user_message", "content": "second", "turn_index": 2, "branch_id": 1},
            {"event_id": 5, "type": "text_chunk", "content": "failed", "turn_index": 2, "branch_id": 1},
            {"event_id": 6, "type": "processing_error", "turn_index": 2, "branch_id": 1},
            {"event_id": 7, "type": "processing_end", "turn_index": 2, "branch_id": 1},
            {"event_id": 8, "type": "user_message", "content": "second", "turn_index": 2, "branch_id": 2},
            {"event_id": 9, "type": "text_chunk", "content": "two", "turn_index": 2, "branch_id": 2},
            {"event_id": 10, "type": "activity:interrupt", "turn_index": 2, "branch_id": 2},
            {"event_id": 11, "type": "processing_end", "turn_index": 2, "branch_id": 2},
        ]

    async def test_metadata_exposes_selected_counts_and_failed_cancelled_branches(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _session, _agent = self.make_runtime(Path(directory), self.events())
            payload = runtime.branch_metadata("session")

        self.assertEqual({1: 1, 2: 2}, payload["branch_counts"])
        self.assertEqual({1: 1, 2: 2}, payload["selected_branch_ids"])
        self.assertEqual("failed", payload["branch_statuses"][2][1])
        self.assertEqual("cancelled", payload["branch_statuses"][2][2])
        self.assertEqual([1, 2], payload["turns"][1]["branches"])

    async def test_selection_replays_and_persists_json_friendly_view(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, session, agent = self.make_runtime(Path(directory), self.events())
            result = await runtime.select_branch_view("session", {"2": 1})
            stored = read_metadata(session.path)

        self.assertEqual({2: 1}, result["branch_view"])
        self.assertEqual({"2": 1}, stored["branch_view"])
        self.assertEqual([{2: 1}], agent.reloads)
        self.assertEqual({2: 1}, session.branch_view)

    async def test_selection_rejects_active_turn_and_pending_or_guide_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, session, _agent = self.make_runtime(Path(directory), self.events())
            runtime._turn_task = asyncio.create_task(asyncio.sleep(10))
            try:
                with self.assertRaisesRegex(RuntimeError, "idle Loom turn"):
                    await runtime.select_branch_view("session", {"2": 1})
            finally:
                runtime._turn_task.cancel()
                await asyncio.gather(runtime._turn_task, return_exceptions=True)

            queue = LoomMessageQueue(session.creature.agent.session_store, "loom")
            queue.enqueue("pending", kind="primary")
            with self.assertRaisesRegex(RuntimeError, "pending or guide queue"):
                await runtime.select_branch_view("session", {"2": 1})

    async def test_regeneration_requires_final_completed_response(self):
        events = [
            {"event_id": 1, "type": "user_message", "content": "question", "turn_index": 1, "branch_id": 1},
            {"event_id": 2, "type": "text_chunk", "content": "answer", "turn_index": 1, "branch_id": 1},
            {"event_id": 3, "type": "processing_end", "turn_index": 1, "branch_id": 1},
            {"event_id": 4, "type": "user_message", "content": "unfinished", "turn_index": 2, "branch_id": 1},
            {"event_id": 5, "type": "processing_error", "turn_index": 2, "branch_id": 1},
        ]
        with tempfile.TemporaryDirectory() as directory:
            runtime, _session, _agent = self.make_runtime(Path(directory), events)
            with self.assertRaisesRegex(RuntimeError, "final completed"):
                await runtime.regenerate_last_response("session")

    async def test_regeneration_uses_local_service_and_selects_new_branch(self):
        events = self.events()
        events[9] = {
            "event_id": 10,
            "type": "tool_result",
            "final_state": "error",
            "turn_index": 2,
            "branch_id": 2,
        }
        with tempfile.TemporaryDirectory() as directory:
            runtime, session, agent = self.make_runtime(Path(directory), events)
            session.branch_view = {2: 2}
            service_result = {"status": "regenerating", "turn_index": 2, "branch_id": 3}
            async def regenerate_native(_session, _view):
                agent.session_store.events.extend(
                    [
                        {"event_id": 12, "type": "user_message", "content": "second", "turn_index": 2, "branch_id": 3},
                        {"event_id": 13, "type": "text_chunk", "content": "three", "turn_index": 2, "branch_id": 3},
                        {"event_id": 14, "type": "processing_end", "turn_index": 2, "branch_id": 3},
                    ]
                )
                return service_result

            regenerate = mock.AsyncMock(side_effect=regenerate_native)
            with mock.patch.object(branch_runtime, "_native_regenerate", new=regenerate):
                agent._turn_index = 2
                agent._branch_id = 3
                result = await runtime.regenerate_last_response("session")
            stored = read_metadata(session.path)

        regenerate.assert_awaited_once_with(session, {2: 2})
        self.assertEqual({2: 3}, result["branch_view"])
        self.assertEqual({"2": 3}, stored["branch_view"])
        self.assertEqual("regenerating", result["status"])
        self.assertEqual(3, result["branch_id"])
        self.assertEqual([{2: 2}, {2: 3}], agent.reloads)

    async def test_edit_and_rerun_selects_new_user_message_branch_and_preserves_old_version(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, session, agent = self.make_runtime(Path(directory), self.events())
            session.branch_view = {2: 2}

            async def edit_native(_session, content, turn_index, user_position, view):
                self.assertEqual((content, turn_index, user_position, view), ("edited second", 2, 1, {2: 2}))
                agent.session_store.events.extend(
                    [
                        {"event_id": 12, "type": "user_message", "content": "edited second", "turn_index": 2, "branch_id": 3},
                        {"event_id": 13, "type": "text_chunk", "content": "edited answer", "turn_index": 2, "branch_id": 3},
                        {"event_id": 14, "type": "processing_end", "turn_index": 2, "branch_id": 3},
                    ]
                )
                return {"status": "edited", "turn_index": 2, "branch_id": 3}

            with mock.patch.object(branch_runtime, "_native_edit", new=mock.AsyncMock(side_effect=edit_native)):
                result = await runtime.edit_and_rerun_message("session", "edited second", 2, 1)
            stored = read_metadata(session.path)

        self.assertEqual({2: 3}, result["branch_view"])
        self.assertEqual({"2": 3}, stored["branch_view"])
        self.assertEqual(["second", "edited second"], [group["content"] for group in result["turns"][1]["user_groups"]])
        self.assertEqual(1, result["turns"][1]["selected_user_group_index"])
        self.assertEqual([{2: 2}, {2: 3}], agent.reloads)

    async def test_native_regenerate_constructs_local_service_with_embedded_view(self):
        session = mock.Mock(creature=mock.Mock(creature_id="loom"), engine=mock.Mock())
        service = mock.Mock()
        service.regenerate = mock.AsyncMock(return_value={"status": "regenerating", "turn_index": 1, "branch_id": 2})
        root_module = types.ModuleType("kohakuterrarium")
        terrarium_module = types.ModuleType("kohakuterrarium.terrarium")
        service_module = types.ModuleType("kohakuterrarium.terrarium.service")
        service_module.LocalTerrariumService = mock.Mock(return_value=service)
        with mock.patch.dict(
            sys.modules,
            {
                "kohakuterrarium": root_module,
                "kohakuterrarium.terrarium": terrarium_module,
                "kohakuterrarium.terrarium.service": service_module,
            },
        ):
            result = await branch_runtime._native_regenerate(session, {1: 1})

        service_module.LocalTerrariumService.assert_called_once_with(session.engine)
        service.regenerate.assert_awaited_once_with("loom", turn_index=None, branch_view={1: 1})
        self.assertEqual(2, result["branch_id"])

    async def test_native_edit_targets_stable_user_position_and_branch_view(self):
        session = mock.Mock(creature=mock.Mock(creature_id="loom"), engine=mock.Mock())
        service = mock.Mock()
        service.edit_message = mock.AsyncMock(return_value={"status": "edited", "turn_index": 2, "branch_id": 4})
        root_module = types.ModuleType("kohakuterrarium")
        terrarium_module = types.ModuleType("kohakuterrarium.terrarium")
        service_module = types.ModuleType("kohakuterrarium.terrarium.service")
        service_module.LocalTerrariumService = mock.Mock(return_value=service)
        with mock.patch.dict(sys.modules, {"kohakuterrarium": root_module, "kohakuterrarium.terrarium": terrarium_module, "kohakuterrarium.terrarium.service": service_module}):
            result = await branch_runtime._native_edit(session, "edited", 2, 1, {1: 1, 2: 2})

        service.edit_message.assert_awaited_once_with("loom", -1, "edited", turn_index=2, user_position=1, branch_view={1: 1, 2: 2})
        self.assertEqual(4, result["branch_id"])

    async def test_branch_operation_replays_same_request(self):
        with tempfile.TemporaryDirectory() as directory:
            events = self.events()
            events[9] = {
                "event_id": 10,
                "type": "text_chunk",
                "content": "two",
                "turn_index": 2,
                "branch_id": 2,
            }
            runtime, session, _agent = self.make_runtime(Path(directory), events)
            session.branch_view = {2: 2}
            service_result = {"status": "regenerating", "turn_index": 2, "branch_id": 3}
            native = mock.AsyncMock(return_value=service_result)
            with mock.patch.object(branch_runtime, "_native_regenerate", new=native):
                first = await runtime.regenerate_last_response("session", "operation-1")
                replay = await runtime.regenerate_last_response("session", "operation-1")

        self.assertEqual(first, replay)
        native.assert_awaited_once_with(session, {2: 2})
        self.assertEqual("completed", session.creature.agent.session_store.state["loom:branch_operations_v1"]["operation-1"]["status"])

    async def test_branch_operation_rejects_payload_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, session, _agent = self.make_runtime(Path(directory), self.events())
            with self.assertRaisesRegex(ValueError, "different branch operation"):
                branch_runtime._begin_operation(session, "regenerate", "operation-1", {"session_id": "session", "branch_view": {2: 1}})
                branch_runtime._begin_operation(session, "regenerate", "operation-1", {"session_id": "session", "branch_view": {2: 2}})

    async def test_branch_operation_rejects_duplicate_in_progress_request(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, session, _agent = self.make_runtime(Path(directory), self.events())
            payload = {"session_id": "session", "branch_view": {2: 1}}
            branch_runtime._begin_operation(session, "regenerate", "operation-1", payload)
            with self.assertRaisesRegex(RuntimeError, "already in progress"):
                branch_runtime._begin_operation(session, "regenerate", "operation-1", payload)


class BranchRouteTests(unittest.TestCase):
    def test_branch_routes_forward_metadata_selection_replay_and_regeneration(self):
        class FakeRuntime:
            def __init__(self):
                self.events = mock.Mock()

                async def subscribe(*_args, **_kwargs):
                    if False:
                        yield None

                self.events.subscribe = subscribe

            def status(self):
                return {"active_session": None, "branch_counts": {}}

            def list_sessions(self):
                return []

            def session_conversation(self, session_id):
                return {"session": {"session_id": session_id}, "messages": []}

            def branch_metadata(self, session_id):
                return {"session_id": session_id, "branch_view": {"2": 1}, "branch_counts": {"2": 2}}

            async def select_branch_view(self, session_id, view):
                return {"session_id": session_id, "branch_view": view}

            async def replay_branch_view(self, session_id, view=None):
                return {"session_id": session_id, "branch_view": view}

            async def regenerate_last_response(self, session_id, operation_id=""):
                del operation_id
                return {"session_id": session_id, "status": "regenerating", "branch_id": 2}

            async def edit_and_rerun_message(self, session_id, content, turn_index, user_position, operation_id=""):
                del operation_id
                return {"session_id": session_id, "content": content, "turn_index": turn_index, "user_position": user_position, "branch_id": 3}

            async def close(self):
                return None

        with tempfile.TemporaryDirectory() as directory:
            app, _ = create_app("token", LoomRuntimePaths.under(Path(directory)), runtime=FakeRuntime())
            with TestClient(app) as client:
                headers = {"Authorization": "Bearer token"}
                branches = client.get("/sessions/s/branches", headers=headers)
                selected = client.patch("/sessions/s/branch-view", headers=headers, json={"branch_view": {"2": 2}})
                replayed = client.post("/sessions/s/branch-view/replay", headers=headers, json={})
                regenerated = client.post("/sessions/s/regenerate", headers=headers)
                edited = client.post("/sessions/s/edit-rerun", headers=headers, json={"content": "edited", "turn_index": 2, "user_position": 1})

        self.assertEqual(200, branches.status_code)
        self.assertEqual({"2": 2}, selected.json()["branch_view"])
        self.assertEqual(200, replayed.status_code)
        self.assertEqual(2, regenerated.json()["branch_id"])
        self.assertEqual({"content": "edited", "turn_index": 2, "user_position": 1, "branch_id": 3}, {key: edited.json()[key] for key in ("content", "turn_index", "user_position", "branch_id")})


if __name__ == "__main__":
    unittest.main()
