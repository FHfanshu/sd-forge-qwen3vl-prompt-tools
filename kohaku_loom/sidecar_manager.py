from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request
import venv
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .runtime_paths import EXTENSION_ROOT, LoomRuntimePaths


RUNTIME_CAPABILITY_LEVEL = 2
KOHakuTERRARIUM_COMMIT = "f22b739d19785b9a065ac839a83eda457daba030"


def _run_subprocess(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess:
    """Keep managed-runtime commands out of Forge's global uv subprocess hook."""
    original_run = getattr(subprocess, "__original_run", None)
    runner = original_run if callable(original_run) else subprocess.run
    return runner(*args, **kwargs)


class SidecarManager:
    def __init__(self, extension_root: Path = EXTENSION_ROOT):
        self.extension_root = extension_root.resolve()
        self.paths = LoomRuntimePaths.under(self.extension_root).ensure()
        self.process: subprocess.Popen | None = None

    def ensure_environment(self) -> dict[str, Any]:
        if os.name != "nt":
            raise RuntimeError("Kohaku Loom managed sidecar currently supports Windows only")
        if not self.paths.python.exists():
            print(f"[Kohaku Loom] Creating sidecar venv at {self.paths.venv}", flush=True)
            venv.EnvBuilder(with_pip=True).create(self.paths.venv)
        lock = self._read_json(self.paths.lock_file, {})
        if self._lock_is_valid(lock):
            try:
                self._probe_kohakuterrarium()
                return lock
            except subprocess.CalledProcessError:
                print("[Kohaku Loom] Existing runtime failed its capability probe; repairing...", flush=True)
                lock = {}

        env = self._sidecar_env()
        if lock.get("ready") is not True or not self._lock_is_valid(lock):
            requirements = self.extension_root / "sidecar-requirements.txt"
            with self._installation_lock():
                lock = self._read_json(self.paths.lock_file, {})
                if self._lock_is_valid(lock):
                    self._probe_kohakuterrarium()
                    return lock
                print("[Kohaku Loom] Installing sidecar dependencies...", flush=True)
                try:
                    _run_subprocess(
                        [str(self.paths.python), "-m", "pip", "install", "-r", str(requirements)],
                        check=True,
                        env=env,
                    )
                    source, commit = self._install_kohakuterrarium()
                    version = self._probe_kohakuterrarium()
                    _run_subprocess(
                        [str(self.paths.python), "-m", "kohakuterrarium", "install", str(self.extension_root), "-e"],
                        check=True,
                        env=env,
                    )
                except PermissionError as error:
                    raise RuntimeError(
                        "Kohaku Loom could not update sidecar dependencies because a Python process "
                        "is using the managed runtime. Stop Forge and retry the sidecar installation."
                    ) from error
                except subprocess.CalledProcessError as error:
                    raise RuntimeError(
                        "Kohaku Loom sidecar dependency installation failed. Check the Forge log; "
                        "if it reports access denied for a Python package file, stop Forge and retry."
                    ) from error
                lock = {
                    "ready": True,
                    "kohakuterrarium_version": version,
                    "source": source,
                    "commit": commit,
                    "capability_level": RUNTIME_CAPABILITY_LEVEL,
                    "installed_at": time.time(),
                }
                self._write_json(self.paths.lock_file, lock)
                suffix = f" ({commit[:12]})" if commit else ""
                print(f"[Kohaku Loom] Runtime locked to KohakuTerrarium {version}{suffix}", flush=True)
        return lock

    @contextmanager
    def _installation_lock(self):
        lock_path = self.paths.runtime / "install.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.touch(exist_ok=True)
        handle = lock_path.open("r+b")
        try:
            import msvcrt

            handle.seek(0)
            handle.write(b"0")
            handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            yield
        finally:
            # Windows releases the advisory lock when the owning handle closes.
            handle.close()

    def _install_kohakuterrarium(self) -> tuple[str, str]:
        commit = KOHakuTERRARIUM_COMMIT
        spec = f"git+https://github.com/Kohaku-Lab/KohakuTerrarium.git@{commit}"
        print(f"[Kohaku Loom] Installing audited KohakuTerrarium snapshot {commit[:12]}...", flush=True)
        _run_subprocess(
            [
                str(self.paths.python),
                "-m",
                "pip",
                "install",
                "--force-reinstall",
                "--no-deps",
                spec,
            ],
            check=True,
            env=self._sidecar_env(),
        )
        self._probe_kohakuterrarium()
        return "github-pinned", commit

    def _probe_kohakuterrarium(self) -> str:
        return _run_subprocess(
            [
                str(self.paths.python),
                "-c",
                (
                    "import kohakuterrarium; "
                    "from kohakuterrarium.core.agent import Agent; "
                    "from kohakuterrarium.terrarium import Terrarium; "
                    "from kohakuterrarium.terrarium.creature_host import Creature; "
                    "assert callable(getattr(Agent, 'build', None)); "
                    "assert callable(getattr(Agent, 'run_stream', None)); "
                    "assert callable(getattr(Agent, 'inject_input', None)); "
                    "assert callable(getattr(Agent, 'edit_pending', None)); "
                     "assert callable(getattr(Agent, 'cancel_pending', None)); "
                     "assert callable(getattr(Terrarium, 'resume', None)); "
                     "assert callable(getattr(Creature, 'run_stream', None)); "
                      "assert callable(getattr(Creature, 'wait_restoration_ready', None)); "
                      "from kohakuterrarium.terrarium.service import LocalTerrariumService; "
                      "assert callable(getattr(LocalTerrariumService, 'regenerate', None)); "
                      "assert callable(getattr(LocalTerrariumService, 'edit_message', None)); "
                      "from kohakuterrarium.session.history import replay_conversation, collect_branch_metadata, collect_user_groups, select_live_event_ids; "
                      "assert callable(replay_conversation); "
                      "assert callable(collect_branch_metadata); "
                      "assert callable(collect_user_groups); "
                      "assert callable(select_live_event_ids); "
                     "assert callable(getattr(Agent, '_reload_conversation_under_branch_view', None)); "
                     "from kohakuterrarium.session.store import SessionStore; "
                    "assert callable(getattr(SessionStore, 'token_usage', None)); "
                    "print(kohakuterrarium.__version__)"
                ),
            ],
            check=True,
            capture_output=True,
            text=True,
            env=self._sidecar_env(),
        ).stdout.strip()

    @staticmethod
    def _lock_is_valid(lock: Any) -> bool:
        if not isinstance(lock, dict) or lock.get("ready") is not True:
            return False
        if not str(lock.get("kohakuterrarium_version") or "").strip():
            return False
        if lock.get("capability_level") != RUNTIME_CAPABILITY_LEVEL:
            return False
        source = lock.get("source")
        commit = str(lock.get("commit") or "")
        return source == "pypi" and not commit or source == "github-pinned" and len(commit) == 40

    def _sidecar_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["KT_CONFIG_DIR"] = str(self.paths.config)
        env["KT_SESSION_DIR"] = str(self.paths.sessions)
        env["PIP_CACHE_DIR"] = str(self.paths.cache / "pip")
        env["PYTHONPATH"] = os.pathsep.join(
            item for item in (str(self.extension_root), env.get("PYTHONPATH", "")) if item
        )
        return env

    def start(self, idle_timeout: int = 900) -> dict[str, Any]:
        existing = self.state()
        if existing and self._healthy(existing):
            return existing
        self.stop()
        self.ensure_environment()
        port = self._free_port()
        token = secrets.token_urlsafe(32)
        env = self._sidecar_env()
        command = [
            str(self.paths.python),
            "-m",
            "kohaku_loom.sidecar",
            "--port",
            str(port),
            "--token",
            token,
            "--extension-root",
            str(self.extension_root),
            "--idle-timeout",
            str(idle_timeout),
        ]
        print("[Kohaku Loom] Starting managed sidecar...", flush=True)
        self.process = subprocess.Popen(command, cwd=self.extension_root, env=env)
        state = {"pid": self.process.pid, "port": port, "token": token, "started_at": time.time()}
        self._write_json(self.paths.state_file, state)
        for _ in range(120):
            if self.process.poll() is not None:
                raise RuntimeError(f"Kohaku Loom sidecar exited with code {self.process.returncode}")
            if self._healthy(state):
                return state
            time.sleep(0.25)
        self.stop()
        raise RuntimeError("Kohaku Loom sidecar did not become healthy")

    def stop(self) -> None:
        state = self.state()
        process = self.process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        elif state and self._pid_running(int(state.get("pid") or 0)):
            subprocess.run(["taskkill", "/PID", str(state["pid"]), "/T", "/F"], check=False)
        self.process = None
        try:
            self.paths.state_file.unlink()
        except FileNotFoundError:
            pass

    def state(self) -> dict[str, Any] | None:
        state = self._read_json(self.paths.state_file, None)
        return state if isinstance(state, dict) else None

    def _healthy(self, state: dict[str, Any]) -> bool:
        request = urllib.request.Request(
            f"http://127.0.0.1:{int(state['port'])}/health",
            headers={"Authorization": f"Bearer {state['token']}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=0.5) as response:
                payload = json.loads(response.read().decode("utf-8"))
                return response.status == 200 and payload.get("ok") is True
        except (OSError, ValueError, urllib.error.URLError):
            return False

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    @staticmethod
    def _pid_running(pid: int) -> bool:
        if pid <= 0:
            return False
        result = _run_subprocess(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            check=False,
        )
        return str(pid) in result.stdout

    @staticmethod
    def _read_json(path: Path, fallback: Any) -> Any:
        if not path.exists():
            return fallback
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return fallback

    @staticmethod
    def _write_json(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=True, indent=2), encoding="utf-8")
        os.replace(temporary, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
