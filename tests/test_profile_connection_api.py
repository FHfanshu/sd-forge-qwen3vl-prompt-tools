from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from kohaku_loom.profile_store import LoomProfileStore
from kohaku_loom.provider_errors import provider_http_status
from kohaku_loom.runtime_paths import LoomRuntimePaths
from kohaku_loom.sidecar.app import create_app


def profile_state() -> dict:
    return {
        "active_profile_id": "remote",
        "teacher_profile_id": "remote",
        "session_profile_id": "",
        "naming_profile_id": "",
        "profiles": [
            {
                "id": "remote",
                "display_name": "Remote",
                "enabled": True,
                "protocol": "openai-chat-completions",
                "runtime": "remote-http",
                "endpoint": "https://example.com/v1",
                "model_id": "example-model",
                "api_key": "secret-value",
                "fallback_endpoints": [],
                "capabilities": {"tools": True, "vision": False, "streaming": True, "reasoning": True},
                "parameters": {"temperature": 0.3, "top_p": 0.9, "max_tokens": 1024, "timeout": 60},
            }
        ],
    }


class ProfileConnectionApiTests(unittest.TestCase):
    def test_extracts_google_style_auth_status_without_status_code(self):
        class GoogleClientError(RuntimeError):
            code = 403

        self.assertEqual(403, provider_http_status(GoogleClientError("403 invalid credential")))

    def _app(self, runtime):
        directory = tempfile.TemporaryDirectory()
        paths = LoomRuntimePaths.under(Path(directory.name)).ensure()
        LoomProfileStore(paths).import_state(profile_state())
        app, _ = create_app("secret-token", paths, runtime=runtime)
        return directory, app

    def test_returns_sanitized_provider_error_with_transport(self):
        class FailingRuntime:
            async def profile_chat(self, profile_id, messages):
                del profile_id, messages
                error = RuntimeError("upstream rejected secret-token")
                error.code = 401
                raise error

            async def close(self):
                return None

        directory, app = self._app(FailingRuntime())
        try:
            with mock.patch("kohaku_loom.sidecar.app.http_transport_summary", return_value="system/environment proxy http://127.0.0.1:7890"):
                with TestClient(app) as client:
                    response = client.post(
                        "/profiles/remote/chat",
                        headers={"Authorization": "Bearer secret-token"},
                        json={"messages": [{"role": "user", "content": "ping"}], "timeout": 1},
                    )
        finally:
            directory.cleanup()

        self.assertEqual(502, response.status_code)
        self.assertEqual(
            "Provider rejected the configured credentials (HTTP 401). Route: system/environment proxy http://127.0.0.1:7890.",
            response.json()["detail"],
        )
        self.assertNotIn("secret-token", response.text)

    def test_timeout_is_bounded_and_reports_transport(self):
        class SlowRuntime:
            async def profile_chat(self, profile_id, messages):
                del profile_id, messages
                await asyncio.sleep(1)

            async def close(self):
                return None

        directory, app = self._app(SlowRuntime())
        try:
            with mock.patch("kohaku_loom.sidecar.app.http_transport_summary", return_value="direct"):
                with TestClient(app) as client:
                    response = client.post(
                        "/profiles/remote/chat",
                        headers={"Authorization": "Bearer secret-token"},
                        json={"messages": [{"role": "user", "content": "ping"}], "timeout": 0.01},
                    )
        finally:
            directory.cleanup()

        self.assertEqual(504, response.status_code)
        self.assertEqual("Model connection test timed out after 0.01 seconds. Route: direct.", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
