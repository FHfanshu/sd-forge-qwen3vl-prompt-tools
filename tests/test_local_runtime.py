from __future__ import annotations

import asyncio
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from backend.prompt_agent.local_runtime import LocalLlamaRuntime, _server_command


class Process:
    def __init__(self):
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, _timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("llama-server", 5)
        return self.returncode


def profile(root: Path, *, unload: bool = True) -> dict:
    server = root / "llama-server.exe"
    model = root / "model.gguf"
    mmproj = root / "mmproj.gguf"
    draft = root / "draft.gguf"
    for path in (server, model, mmproj, draft):
        path.write_bytes(b"x")
    return {
        "profile_id": "local",
        "display_name": "Local",
        "model_id": "gemma-4-12b-it",
        "enabled": True,
        "protocol": "openai-chat-completions",
        "runtime": "llama-once",
        "model_path": str(model),
        "mmproj_path": str(mmproj),
        "draft_model_path": str(draft),
        "llama_server_path": str(server),
        "n_ctx": 16384,
        "n_gpu_layers": -1,
        "thinking": False,
        "unload_after_turn": unload,
        "parameters": {"timeout": 30},
    }


class LocalRuntimeTests(unittest.TestCase):
    def test_command_uses_loopback_gpu_vision_and_mtp(self):
        with TemporaryDirectory() as directory:
            item = profile(Path(directory))
            with patch("backend.prompt_agent.local_runtime._trusted_server", return_value=item["llama_server_path"]):
                command, _signature = _server_command(item)
        joined = " ".join(command)
        self.assertIn("-ngl all", joined)
        self.assertIn("--host 127.0.0.1", joined)
        self.assertIn("--mmproj", command)
        self.assertIn("--spec-draft-model", command)
        self.assertIn("--spec-type draft-mtp", joined)
        self.assertIn("--cache-ram 0", joined)

    def test_default_stop_unloads_and_resident_mode_reuses_process(self):
        async def run(unload: bool):
            with TemporaryDirectory() as directory:
                item = profile(Path(directory), unload=unload)
                process = Process()
                runtime = LocalLlamaRuntime()
                with (
                    patch("backend.prompt_agent.local_runtime._trusted_server", return_value=item["llama_server_path"]),
                    patch("backend.prompt_agent.local_runtime._spawn", return_value=process) as spawn,
                    patch("backend.prompt_agent.local_runtime._wait_ready", new=AsyncMock()),
                ):
                    await runtime.start_turn("turn-1", item)
                    routed = await runtime.stream_profile("turn-1", item)
                    first = await runtime.stop_turn("turn-1")
                    if not unload:
                        await runtime.start_turn("turn-2", item)
                        await runtime.stop_turn("turn-2", force=True)
                    return process, spawn.call_count, routed, first

        unloaded, unload_starts, routed, result = asyncio.run(run(True))
        self.assertEqual("llama-endpoint", routed["runtime"])
        self.assertTrue(result["stopped"])
        self.assertTrue(unloaded.terminated)
        self.assertEqual(1, unload_starts)

        resident, resident_starts, _routed, result = asyncio.run(run(False))
        self.assertFalse(result["stopped"])
        self.assertEqual(1, resident_starts)
        self.assertTrue(resident.terminated)

    def test_force_stop_terminates_while_model_is_loading(self):
        async def run():
            with TemporaryDirectory() as directory:
                item = profile(Path(directory))
                process = Process()
                loading = asyncio.Event()
                release = asyncio.Event()

                async def wait_ready(*_args):
                    loading.set()
                    await release.wait()

                runtime = LocalLlamaRuntime()
                with (
                    patch("backend.prompt_agent.local_runtime._trusted_server", return_value=item["llama_server_path"]),
                    patch("backend.prompt_agent.local_runtime._spawn", return_value=process),
                    patch("backend.prompt_agent.local_runtime._wait_ready", side_effect=wait_ready),
                ):
                    startup = asyncio.create_task(runtime.start_turn("turn-loading", item))
                    await asyncio.wait_for(loading.wait(), timeout=1)
                    stopped = await runtime.stop_turn("turn-loading", force=True)
                    release.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await startup
                    return process, stopped, runtime

        process, stopped, runtime = asyncio.run(run())
        self.assertTrue(stopped["stopped"])
        self.assertTrue(process.terminated)
        self.assertIsNone(runtime._process)


if __name__ == "__main__":
    unittest.main()
