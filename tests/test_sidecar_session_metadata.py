from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from kohaku_loom.sidecar.session_metadata import (
    SessionMetadataQueue,
    fallback_metadata,
    generate_metadata,
    metadata_path,
    metadata_payload,
)


class SessionMetadataTests(unittest.TestCase):
    def test_fallback_uses_first_user_request(self):
        title, description = fallback_metadata([
            {"role": "user", "content": "Create a copper-haired portrait with rainy window lighting."},
            {"role": "assistant", "content": "Use a soft rim light."},
        ])
        self.assertEqual("Create a copper-haired portrait with rainy window lighting.", title)
        self.assertIn("copper-haired", description)

    def test_generated_response_is_parsed_without_extra_text(self):
        profile = {"profile_id": "local", "runtime": "llama-once"}
        messages = [{"role": "user", "content": "Design a portrait prompt."}, {"role": "assistant", "content": "Done."}]
        with mock.patch(
            "kohaku_loom.sidecar.session_metadata.prompt_assistant_chat",
            return_value={"text": "TITLE: Rainy portrait prompt\nDESCRIPTION: Builds a portrait prompt and lighting direction."},
        ):
            title, description = generate_metadata(profile, messages)
        self.assertEqual("Rainy portrait prompt", title)
        self.assertEqual("Builds a portrait prompt and lighting direction.", description)

    def test_queue_persists_completion_and_serializes_jobs(self):
        async def run() -> None:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                paths = {session_id: root / f"{session_id}.kohakutr" for session_id in ("one", "two")}
                for path in paths.values():
                    path.touch()
                published = []
                queue = SessionMetadataQueue(
                    lambda: {"profile_id": "local", "runtime": "llama-once"},
                    lambda session_id: [{"role": "user", "content": f"task {session_id}"}],
                    lambda session_id: paths[session_id],
                    lambda: False,
                    lambda event_type, payload: published.append((event_type, payload)),
                )
                with mock.patch(
                    "kohaku_loom.sidecar.session_metadata.generate_metadata",
                    side_effect=[("One title", "One description"), ("Two title", "Two description")],
                ):
                    queue.schedule("one")
                    queue.schedule("two")
                    await asyncio.gather(*list(queue._tasks.values()))
                self.assertEqual("completed", metadata_payload("one", paths["one"])["status"])
                self.assertEqual("Two title", metadata_payload("two", paths["two"])["title"])
                self.assertTrue(metadata_path(paths["one"]).is_file())
                self.assertGreaterEqual(len(published), 4)

        asyncio.run(run())

    def test_queue_uses_source_snapshot_after_session_switch(self):
        async def run() -> None:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "one.kohakutr"
                path.touch()
                calls = 0

                def messages(_session_id):
                    nonlocal calls
                    calls += 1
                    if calls > 1:
                        raise RuntimeError("session is no longer active")
                    return [
                        {"role": "user", "content": "Create a rainy portrait."},
                        {"role": "assistant", "content": "The prompt is ready."},
                    ]

                queue = SessionMetadataQueue(
                    lambda: {"profile_id": "local", "runtime": "llama-once"},
                    messages,
                    lambda _session_id: path,
                    lambda: False,
                    lambda *_args: None,
                )
                with mock.patch(
                    "kohaku_loom.sidecar.session_metadata.generate_metadata",
                    return_value=("Rainy portrait", "Creates a rainy portrait prompt."),
                ):
                    queue.schedule("one")
                    await asyncio.gather(*list(queue._tasks.values()))
                result = metadata_payload("one", path)
                self.assertEqual("completed", result["status"])
                self.assertEqual("Rainy portrait", result["title"])
                self.assertEqual(1, calls)

        asyncio.run(run())

    def test_queue_falls_back_and_records_error(self):
        async def run() -> None:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "one.kohakutr"
                path.touch()
                queue = SessionMetadataQueue(
                    lambda: {"profile_id": "local", "runtime": "llama-once"},
                    lambda _session_id: [{"role": "user", "content": "fallback title"}],
                    lambda _session_id: path,
                    lambda: False,
                    lambda *_args: None,
                )
                with mock.patch("kohaku_loom.sidecar.session_metadata.generate_metadata", side_effect=RuntimeError("offline")):
                    queue.schedule("one")
                    await asyncio.gather(*list(queue._tasks.values()))
                result = metadata_payload("one", path)
                self.assertEqual("fallback", result["status"])
                self.assertEqual("fallback title", result["title"])
                self.assertEqual("offline", result["error"])
                self.assertEqual(1, result["retry_count"])

        asyncio.run(run())

    def test_interrupt_cancels_only_the_active_metadata_run(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "one.kohakutr"
            path.touch()
            queue = SessionMetadataQueue(
                lambda: {"profile_id": "local", "runtime": "llama-once"},
                lambda _session_id: [],
                lambda _session_id: path,
                lambda: False,
                lambda *_args: None,
            )
            queue._current_run_id = "metadata-run"
            with mock.patch("kohaku_loom.sidecar.session_metadata.cancel_local_assistant_run") as cancel:
                queue.interrupt()
            cancel.assert_called_once_with("metadata-run")
