from __future__ import annotations

import asyncio
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from kohaku_loom.profile_store import LoomProfileStore
from kohaku_loom.runtime_paths import LoomRuntimePaths
from kohaku_loom.sidecar.message_queue import LoomMessageQueue
from kohaku_loom.sidecar.runtime import LoomSidecarRuntime


class Store:
    def __init__(self):
        self.state = {}

    def append_event(self, *args, **kwargs):
        del args, kwargs

    def token_usage(self, *args, **kwargs):
        del args, kwargs
        return {}


class LoomRuntimeResilienceTests(unittest.IsolatedAsyncioTestCase):
    async def test_guide_injection_race_converts_unclaimed_guide_to_primary(self):
        started = asyncio.Event()
        release = asyncio.Event()

        class Agent:
            def __init__(self):
                self.config = mock.Mock(name="loom")
                self.session_store = Store()

            async def inject_input(self, content, source, pending_id):
                del content, source, pending_id
                started.set()
                await release.wait()
                return False

            def cancel_pending(self, message_id):
                del message_id
                return True

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            agent = Agent()
            session = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = session
            runtime._turn_id = "turn-1"
            blocker = asyncio.Event()
            runtime._turn_task = asyncio.create_task(blocker.wait())
            runtime._queued_primary_for_turn = True
            runtime._schedule_drain = mock.Mock()
            enqueue = asyncio.create_task(runtime.enqueue_message("unit", "guide"))
            await asyncio.wait_for(started.wait(), timeout=1)
            settle = asyncio.create_task(runtime._settle_turn(session, "turn-1", {"status": "ok"}))
            release.set()
            item = await asyncio.wait_for(enqueue, timeout=1)
            await asyncio.wait_for(settle, timeout=1)
            runtime._turn_task.cancel()
            await asyncio.gather(runtime._turn_task, return_exceptions=True)

        recovered = LoomMessageQueue(agent.session_store, "loom").get(item["message_id"])
        self.assertEqual("primary", recovered["kind"])
        self.assertEqual("pending", recovered["state"])
        self.assertEqual("", recovered["turn_id"])

    async def test_guide_injection_error_remains_actionable(self):
        class Agent:
            config = mock.Mock(name="loom")
            session_store = Store()

            async def inject_input(self, content, source, pending_id):
                del content, source, pending_id
                raise RuntimeError("injection failed")

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=Agent()))
            runtime._turn_id = "turn-1"
            blocker = asyncio.Event()
            runtime._turn_task = asyncio.create_task(blocker.wait())
            runtime._queued_primary_for_turn = True
            item = await runtime.enqueue_message("unit", "guide")
            runtime._turn_task.cancel()
            await asyncio.gather(runtime._turn_task, return_exceptions=True)

        self.assertEqual("primary", item["kind"])
        self.assertEqual("pending", item["state"])
        self.assertIn("injection failed", item["error"])

    async def test_new_enqueue_does_not_resume_paused_pending_head(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            store = Store()
            queue = LoomMessageQueue(store, "loom")
            head = queue.enqueue("head", kind="primary")
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            runtime._paused = True
            runtime._schedule_drain = mock.Mock()

            later = await runtime.enqueue_message("unit", "later")

        self.assertTrue(runtime._paused)
        self.assertEqual("pending", queue.get(head["message_id"])["state"])
        self.assertEqual("pending", later["state"])
        runtime._schedule_drain.assert_not_called()

    async def test_provider_cleanup_error_cannot_skip_queue_settlement(self):
        class TurnEnded:
            def __init__(self, result):
                self.result = result

        class Provider:
            last_assistant_extra_fields = {}

            async def end_turn(self):
                raise RuntimeError("shutdown failed")

        class Agent:
            config = mock.Mock(name="loom")
            session_store = Store()

            def resume(self):
                return None

        class Creature:
            agent = Agent()

            async def run_stream(self, content, **kwargs):
                del content, kwargs
                yield TurnEnded(mock.Mock(status="ok", text="done", error=None, usage={}, duration_s=0.1, interrupted_by_user=False))

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            session = mock.Mock(session_id="unit", path=paths.sessions / "unit.kohakutr", creature=Creature(), provider=Provider())
            runtime.active = session
            runtime._schedule_drain = mock.Mock()
            queue = LoomMessageQueue(Creature.agent.session_store, "loom")
            item = queue.enqueue("queued", kind="primary")
            fake_kt = types.ModuleType("kohakuterrarium")
            fake_kt.Activity = type("Activity", (), {})
            fake_kt.TextChunk = type("TextChunk", (), {})
            fake_kt.TurnEnded = TurnEnded
            with mock.patch.dict("sys.modules", {"kohakuterrarium": fake_kt}):
                runtime._launch_turn(session, item["content"], None, message_id=item["message_id"])
                queue.mark(item["message_id"], "running", turn_id=runtime._turn_id)
                await asyncio.wait_for(runtime._turn_task, timeout=1)

        self.assertEqual("delivered", queue.get(item["message_id"])["state"])
        self.assertTrue(any(event["type"] == "provider_cleanup_error" for event in runtime.events.after(0)))

    async def test_cancel_turn_cancels_pending_forge_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            broker = mock.Mock()
            broker.cancel_all = mock.AsyncMock()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), broker)
            agent = mock.Mock()
            runtime.active = mock.Mock(creature=mock.Mock(agent=agent))
            blocker = asyncio.Event()
            runtime._turn_id = "turn-1"
            runtime._turn_task = asyncio.create_task(blocker.wait())

            status = await runtime.cancel_turn("turn-1")
            runtime._turn_task.cancel()
            await asyncio.gather(runtime._turn_task, return_exceptions=True)

        self.assertEqual("accepted", status)
        agent.interrupt.assert_called_once_with()
        broker.cancel_all.assert_awaited_once_with("turn_cancelled")

    async def test_turn_operation_id_replays_existing_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock()
            runtime._turn_snapshot = {"turn_id": "turn-1", "operation_id": "browser:turn:1"}

            replay = await runtime.start_turn("ignored", operation_id="browser:turn:1")

        self.assertEqual("turn-1", replay["turn_id"])
        self.assertEqual("browser:turn:1", replay["operation_id"])

    async def test_message_operation_id_does_not_duplicate_queue_item(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            store = Store()
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            runtime._schedule_drain = mock.Mock()

            first = await runtime.enqueue_message("unit", "first", operation_id="browser:message:1")
            replay = await runtime.enqueue_message("unit", "duplicate", operation_id="browser:message:1")

        self.assertEqual(first["message_id"], replay["message_id"])
        self.assertEqual(1, len(LoomMessageQueue(store, "loom").list()))

    async def test_cancelled_successful_terminal_fails_active_primary(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            store = Store()
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            session = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = session
            message_id = LoomMessageQueue(store, "loom").enqueue("queued", kind="primary")["message_id"]
            runtime._active_message_id = message_id
            runtime._cancel_requested = True

            await runtime._settle_turn(session, "turn-1", {"status": "ok"})

        item = LoomMessageQueue(store, "loom").get(message_id)
        self.assertEqual("failed", item["state"])
        self.assertEqual("cancelled", item["error"])

    async def test_cancel_during_settling_does_not_change_terminal_success(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(creature=mock.Mock(agent=mock.Mock()))
            runtime._turn_id = "turn-1"
            runtime._turn_task = asyncio.create_task(asyncio.sleep(10))
            runtime._turn_snapshot = {"turn_id": "turn-1", "terminal": {"status": "ok"}}

            status = await runtime.cancel_turn("turn-1")
            runtime._turn_task.cancel()
            await asyncio.gather(runtime._turn_task, return_exceptions=True)

        self.assertEqual("unknown", status)


if __name__ == "__main__":
    unittest.main()
