from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.prompt_agent import API_PREFIX, register_prompt_agent_api
from backend.prompt_agent.profiles import ProfileAuthority
from backend.prompt_agent.session_sync import SessionSyncAuthority, SessionSyncError
from quality.acceptance import acceptance


def snapshot(session_id: str = "session-a", revision: int | None = None, text: str = "hello") -> dict:
    value = {
        "session": {
            "id": session_id,
            "title": text,
            "createdAt": 100,
            "updatedAt": 200,
            "profileId": "local-endpoint",
            "providerId": "llama-cpp",
            "modelId": "local-model",
            "reasoningLevel": "off",
            "systemPrompt": "",
            "schemaVersion": 1,
        },
        "messages": [{
            "id": f"{session_id}:user:100",
            "sessionId": session_id,
            "message": {"role": "user", "content": text, "timestamp": 100},
            "status": "complete",
            "createdAt": 100,
            "updatedAt": 200,
        }],
    }
    if revision is not None:
        value["revision"] = revision
    return value


class SessionSyncTests(unittest.TestCase):
    @acceptance("SESSION-SYNC-001@1", "cross-device")
    def test_second_device_pulls_server_snapshot(self):
        with TemporaryDirectory() as directory:
            authority = SessionSyncAuthority(Path(directory))
            first = authority.sync({"device_id": "device-a", "sessions": [snapshot()]})
            second = authority.sync({"device_id": "device-b", "sessions": []})

        self.assertEqual(first["sessions"][0]["revision"], 1)
        self.assertEqual(len(first["sessions"][0]["content_hash"]), 64)
        self.assertEqual(second["sessions"][0]["session"]["id"], "session-a")
        self.assertEqual(second["sessions"][0]["messages"][0]["message"]["content"], "hello")

    @acceptance("SESSION-SYNC-001@1", "conflict")
    def test_stale_revision_creates_conflict_copy_without_overwrite(self):
        with TemporaryDirectory() as directory:
            authority = SessionSyncAuthority(Path(directory))
            authority.sync({"device_id": "device-a", "sessions": [snapshot()]})
            current = snapshot(revision=1, text="device a edit")
            current["session"]["updatedAt"] = 300
            updated = authority.sync({"device_id": "device-a", "sessions": [current]})
            stale = snapshot(revision=1, text="device b edit")
            stale["session"]["updatedAt"] = 400
            conflicted = authority.sync({"device_id": "device-b", "sessions": [stale]})

        self.assertEqual(updated["sessions"][0]["revision"], 2)
        self.assertEqual(len(conflicted["sessions"]), 2)
        self.assertEqual(conflicted["sessions"][1]["messages"][0]["message"]["content"], "device a edit")
        conflict_id = conflicted["conflicts"][0]["conflict_session_id"]
        conflict = next(item for item in conflicted["sessions"] if item["session"]["id"] == conflict_id)
        self.assertEqual(conflict["messages"][0]["message"]["content"], "device b edit")
        self.assertIn("conflict copy", conflict["session"]["title"])

    def test_stale_but_unchanged_snapshot_pulls_without_false_conflict(self):
        with TemporaryDirectory() as directory:
            authority = SessionSyncAuthority(Path(directory))
            initial = authority.sync({"device_id": "device-a", "sessions": [snapshot()]})["sessions"][0]
            stale_unchanged = snapshot(revision=initial["revision"])
            stale_unchanged["base_hash"] = initial["content_hash"]
            edited = snapshot(revision=initial["revision"], text="remote edit")
            authority.sync({"device_id": "device-b", "sessions": [edited]})
            result = authority.sync({"device_id": "device-a", "sessions": [stale_unchanged]})

        self.assertEqual(result["conflicts"], [])
        self.assertEqual(result["sessions"][0]["messages"][0]["message"]["content"], "remote edit")

    @acceptance("SESSION-SYNC-001@1", "validation")
    def test_rejects_cross_session_message_and_unsafe_identifier(self):
        with TemporaryDirectory() as directory:
            authority = SessionSyncAuthority(Path(directory))
            invalid = snapshot()
            invalid["messages"][0]["sessionId"] = "other"
            with self.assertRaisesRegex(SessionSyncError, "must match"):
                authority.sync({"device_id": "device-a", "sessions": [invalid]})
            with self.assertRaisesRegex(SessionSyncError, "safe identifier"):
                authority.sync({"device_id": "../../escape", "sessions": []})

    def test_sync_route_uses_profile_storage_root(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            app = FastAPI()
            register_prompt_agent_api(app, ProfileAuthority(root), SessionSyncAuthority(root))
            response = TestClient(app).post(
                f"{API_PREFIX}/sessions/sync",
                json={"device_id": "device-a", "sessions": [snapshot()]},
            )

            self.assertEqual(response.status_code, 200)
            self.assertTrue((root / "sessions.sqlite3").exists())
            self.assertNotIn(str(root), response.text)


if __name__ == "__main__":
    unittest.main()
