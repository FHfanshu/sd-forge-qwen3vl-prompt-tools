from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

from kohaku_loom.sidecar.message_queue import LoomMessageQueue


class FakeState(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class FakeStore:
    def __init__(self):
        self.state = FakeState()
        self.events = []

    def append_event(self, agent, event_type, data):
        self.events.append((agent, event_type, dict(data)))


class PathStore(FakeStore):
    def __init__(self, path):
        super().__init__()
        self.path = str(path)


class LoomMessageQueueTests(unittest.TestCase):
    def test_fifo_edit_cancel_and_claim_boundary(self):
        store = FakeStore()
        queue = LoomMessageQueue(store, "loom")
        first = queue.enqueue("first", kind="primary")
        second = queue.enqueue("second", kind="primary")

        edited = queue.edit(second["message_id"], "changed")
        cancelled = queue.cancel(second["message_id"])
        running = queue.mark(first["message_id"], "running", turn_id="turn-1")

        self.assertEqual("changed", edited["content"])
        self.assertEqual("cancelled", cancelled["state"])
        self.assertEqual("running", running["state"])
        with self.assertRaisesRegex(RuntimeError, "claimed"):
            queue.edit(first["message_id"], "late")

    def test_waiting_guides_recover_as_primary_messages(self):
        store = FakeStore()
        queue = LoomMessageQueue(store, "loom")
        guide = queue.enqueue("guide", kind="guide")
        running = queue.enqueue("running", kind="primary")
        queue.mark(running["message_id"], "running")

        recovered = queue.recover_interrupted()

        self.assertEqual(2, len(recovered))
        self.assertEqual("pending", queue.get(guide["message_id"])["state"])
        self.assertEqual("primary", queue.get(guide["message_id"])["kind"])
        self.assertEqual("failed", queue.get(running["message_id"])["state"])

    def test_attachments_survive_enqueue_and_edit(self):
        queue = LoomMessageQueue(FakeStore(), "loom")
        first = [{"dataUrl": "data:image/png;base64,one", "name": "one.png"}]
        second = [{"dataUrl": "data:image/png;base64,two", "name": "two.png"}]
        item = queue.enqueue("first", kind="primary", attachments=first)

        edited = queue.edit(item["message_id"], "second", attachments=second)

        self.assertEqual(second, edited["attachments"])

    def test_claimed_guides_recover_as_failed_primary_messages(self):
        queue = LoomMessageQueue(FakeStore(), "loom")
        guide = queue.enqueue("guide", kind="guide")
        queue.mark(guide["message_id"], "claimed", turn_id="turn-1")

        recovered = queue.recover_interrupted()

        self.assertEqual(1, len(recovered))
        item = queue.get(guide["message_id"])
        self.assertEqual("primary", item["kind"])
        self.assertEqual("failed", item["state"])

    def test_operation_id_reuses_the_durable_message(self):
        queue = LoomMessageQueue(FakeStore(), "loom")
        item = queue.enqueue("first", kind="primary", operation_id="browser:message:1")

        replay = queue.by_operation("browser:message:1")

        self.assertEqual(item["message_id"], replay["message_id"])

    def test_failed_message_cannot_be_edited_or_cancelled(self):
        queue = LoomMessageQueue(FakeStore(), "loom")
        item = queue.enqueue("first", kind="primary")
        queue.mark(item["message_id"], "failed")

        with self.assertRaisesRegex(RuntimeError, "claimed"):
            queue.edit(item["message_id"], "changed")
        with self.assertRaisesRegex(RuntimeError, "claimed"):
            queue.cancel(item["message_id"])

    def test_terminal_history_is_bounded_and_active_payload_excludes_it(self):
        queue = LoomMessageQueue(FakeStore(), "loom")
        for index in range(60):
            item = queue.enqueue(f"message-{index}", kind="primary")
            queue.mark(item["message_id"], "delivered")
        pending = queue.enqueue("pending", kind="primary")

        self.assertEqual(51, len(queue.list()))
        self.assertEqual([pending["message_id"]], [item["message_id"] for item in queue.active()])

    def test_operation_lookup_survives_terminal_message_compaction(self):
        queue = LoomMessageQueue(FakeStore(), "loom")
        original = queue.enqueue("original", kind="primary", operation_id="browser:message:original")
        queue.mark(original["message_id"], "delivered")
        for index in range(60):
            item = queue.enqueue(f"message-{index}", kind="primary")
            queue.mark(item["message_id"], "delivered")

        replay = queue.by_operation("browser:message:original")

        self.assertEqual(original["message_id"], replay["message_id"])
        self.assertEqual("delivered", replay["state"])

    def test_concurrent_path_backed_enqueues_keep_all_sequences(self):
        with tempfile.TemporaryDirectory() as directory:
            store = PathStore(Path(directory) / "session.kohakutr")
            queues = [LoomMessageQueue(store, "loom") for _ in range(2)]
            results = []
            errors = []

            def enqueue(queue, index):
                try:
                    results.append(queue.enqueue(f"message-{index}", kind="primary"))
                except BaseException as error:  # noqa: BLE001
                    errors.append(error)

            threads = [threading.Thread(target=enqueue, args=(queues[index % 2], index)) for index in range(20)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        self.assertEqual([], errors)
        self.assertEqual(20, len(results))
        self.assertEqual(list(range(1, 21)), sorted(item["sequence"] for item in results))
        self.assertEqual(20, len(LoomMessageQueue(store, "loom").list()))


if __name__ == "__main__":
    unittest.main()
