import tempfile
import unittest
from pathlib import Path

from lib_qwen3vl_prompt_tools.assistant_sessions import AssistantSessionRepository, SessionConflict


class AssistantSessionRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.repository = AssistantSessionRepository(Path(self.directory.name) / "sessions.sqlite3")

    def tearDown(self):
        self.directory.cleanup()

    def test_migration_and_events_survive_repository_restart(self):
        session = self.repository.create_session("Test session", "profile-a", {"model": "test"})
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "Hello"}])
        self.repository.record_turn(run["run_id"], {"text": "Hi", "tool_calls": []}, 1)
        self.repository.checkpoint(run["run_id"], "completed", "final response")

        restored = AssistantSessionRepository(self.repository.database)
        loaded = restored.get_session(session["session_id"])
        events = restored.events(session["session_id"])
        self.assertEqual("completed", loaded["state"])
        self.assertEqual(["user_message", "assistant_message", "checkpoint", "run_completed"], [event["event_type"] for event in events])
        self.assertEqual(list(range(1, len(events) + 1)), [event["sequence"] for event in events])

    def test_running_lease_prevents_duplicate_run_owner(self):
        session = self.repository.create_session()
        self.repository.start_run(session["session_id"], [{"role": "user", "content": "first"}], lease_owner="tab-a")
        with self.assertRaises(SessionConflict):
            self.repository.start_run(session["session_id"], [{"role": "user", "content": "second"}], lease_owner="tab-b")

    def test_waiting_run_can_receive_result_and_resume(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "read"}])
        self.repository.record_turn(
            run["run_id"],
            {"text": "", "tool_calls": [{"id": "call-1", "tool": "read_prompt", "arguments": {}}]},
            1,
        )
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        event = self.repository.append_tool_result(run["run_id"], {"tool_call_id": "call-1", "content": "result"})
        resumed = self.repository.resume_run(run["run_id"], "tab-a")
        self.assertEqual("tool_result", event["event_type"])
        self.assertEqual("running", resumed["status"])

    def test_context_keeps_tool_call_and_result_together(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "x" * 1200}])
        self.repository.record_turn(
            run["run_id"],
            {"text": "", "tool_calls": [{"id": "call-1", "tool": "read_prompt", "arguments": {}}]},
            1,
        )
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        self.repository.append_tool_result(run["run_id"], {"tool_call_id": "call-1", "content": "tool payload"})
        messages = self.repository.context_messages(session["session_id"], token_budget=2048, reserve_tokens=0)
        assistant = next(message for message in messages if message["role"] == "assistant")
        tool = next(message for message in messages if message["role"] == "tool")
        self.assertEqual("call-1", assistant["tool_calls"][0]["id"])
        self.assertEqual("call-1", tool["tool_call_id"])

    def test_missing_provider_tool_id_receives_stable_local_id(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "read"}])
        self.repository.record_turn(run["run_id"], {"text": "", "tool_calls": [{"tool": "read_prompt", "arguments": {}}]}, 1)
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        self.repository.append_tool_result(run["run_id"], {"tool_call_id": "call_1_0", "content": "result"})
        messages = self.repository.context_messages(session["session_id"], token_budget=2048, reserve_tokens=0)
        self.assertEqual("call_1_0", next(item for item in messages if item["role"] == "tool")["tool_call_id"])

    def test_cancellation_records_resumable_checkpoint(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "wait"}])
        self.repository.checkpoint(run["run_id"], "cancelled", "cancelled by user")
        loaded = self.repository.get_run(run["run_id"])
        events = self.repository.events(session["session_id"])
        self.assertEqual("cancelled", loaded["status"])
        self.assertIn("cancelled", [event["event_type"] for event in events])

    def test_duplicate_tool_result_id_is_idempotent(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "wait"}])
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        payload = {"tool_call_id": "call-1", "content": "result"}
        first = self.repository.append_tool_result(run["run_id"], payload)
        second = self.repository.append_tool_result(run["run_id"], payload)
        events = self.repository.events(session["session_id"])
        self.assertEqual(first["event_id"], second["event_id"])
        self.assertEqual(1, sum(event["event_type"] == "tool_result" for event in events))

    def test_optimistic_session_update_rejects_stale_version(self):
        session = self.repository.create_session("Old")
        self.repository.update_session(session["session_id"], title="New", version=session["version"])
        with self.assertRaises(SessionConflict):
            self.repository.update_session(session["session_id"], title="Stale", version=session["version"])


if __name__ == "__main__":
    unittest.main()
