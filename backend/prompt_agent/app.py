from __future__ import annotations

import sqlite3
from typing import Any

from .contracts import parse_stream_request
from .errors import PromptAgentError
from .forge_tools import (
    ForgeToolValidationError,
    validate_forge_tool_request,
)
from .models import public_models
from .local_runtime import LocalLlamaRuntime, LocalRuntimeError
from .profile_connection import ConnectionTestError, test_profile_connection
from .profiles import ProfileAuthority, default_storage_root
from .providers import provider_catalog, public_profile_state, stream_profile
from .session_sync import SessionSyncAuthority, SessionSyncError


API_PREFIX = "/prompt-agent/api"
API_VERSION = 1
_REGISTRATION_MARKER = "_prompt_agent_api_registered"


def health_payload() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "SD Forge Neo Prompt Agent",
        "api_version": API_VERSION,
        "runtime": "frontend-pi",
        "session_storage": "sqlite-sync+indexeddb-cache",
        "features": {
            "agent_loop": True,
            "provider_proxy": True,
            "forge_tools": True,
            "profiles": True,
            "local_models": True,
            "session_sync": True,
        },
    }


def register_prompt_agent_api(
    app: Any,
    profile_authority: ProfileAuthority | None = None,
    session_sync_authority: SessionSyncAuthority | None = None,
) -> None:
    from fastapi import Body, HTTPException
    from fastapi.responses import StreamingResponse

    state = getattr(app, "state", app)
    if getattr(state, _REGISTRATION_MARKER, False):
        return
    setattr(state, _REGISTRATION_MARKER, True)
    profiles = profile_authority or ProfileAuthority()
    session_sync = session_sync_authority or SessionSyncAuthority(getattr(profiles, "root", default_storage_root()))
    local_runtime = LocalLlamaRuntime()
    setattr(state, "_prompt_agent_local_runtime", local_runtime)
    if hasattr(app, "add_event_handler"):
        app.add_event_handler("shutdown", local_runtime.close)

    @app.get(f"{API_PREFIX}/health")
    async def prompt_agent_health() -> dict[str, Any]:
        return health_payload()

    @app.get(f"{API_PREFIX}/profiles")
    async def prompt_agent_profiles() -> dict[str, Any]:
        return profiles.list_state()

    @app.post(f"{API_PREFIX}/sessions/sync")
    async def prompt_agent_session_sync(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return session_sync.sync(payload)
        except (OSError, SessionSyncError, sqlite3.Error) as error:
            status = 422 if isinstance(error, SessionSyncError) else 503
            detail = str(error) if isinstance(error, SessionSyncError) else "Session synchronization is unavailable."
            raise HTTPException(status_code=status, detail=detail) from error

    @app.get(f"{API_PREFIX}/profiles/{{profile_id}}")
    async def prompt_agent_profile(profile_id: str) -> dict[str, Any]:
        try:
            return profiles.get(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error

    @app.post(f"{API_PREFIX}/profiles")
    async def prompt_agent_create_profile(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return profiles.create(payload)
        except (OSError, RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.patch(f"{API_PREFIX}/profiles/{{profile_id}}")
    async def prompt_agent_update_profile(profile_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return profiles.update(profile_id, payload)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        except (OSError, RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.delete(f"{API_PREFIX}/profiles/{{profile_id}}", status_code=204)
    async def prompt_agent_delete_profile(profile_id: str) -> None:
        try:
            profiles.delete(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post(f"{API_PREFIX}/profiles/{{profile_id}}/duplicate")
    async def prompt_agent_duplicate_profile(profile_id: str) -> dict[str, Any]:
        try:
            return profiles.duplicate(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error

    @app.post(f"{API_PREFIX}/profiles/import")
    async def prompt_agent_import_profiles(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return profiles.import_legacy_state(payload)
        except (RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(f"{API_PREFIX}/profile-routes/default")
    async def prompt_agent_set_profile_route(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return profiles.set_default(str(payload.get("role") or ""), str(payload.get("profile_id") or ""))
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(f"{API_PREFIX}/profiles/restore-defaults")
    async def prompt_agent_restore_default_profiles() -> dict[str, Any]:
        return profiles.restore_defaults()

    @app.get(f"{API_PREFIX}/providers")
    async def prompt_agent_providers() -> dict[str, Any]:
        profile_state = profiles.list_state()
        return {"providers": provider_catalog(profile_state)}

    @app.get(f"{API_PREFIX}/models")
    async def prompt_agent_models() -> dict[str, Any]:
        return public_models(profiles.list_state())

    @app.get(f"{API_PREFIX}/profiles/{{profile_id}}/models")
    async def prompt_agent_profile_models(profile_id: str) -> dict[str, Any]:
        try:
            profile = profiles.get(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        return public_models({"profiles": [profile]})

    @app.post(f"{API_PREFIX}/forge-tools/validate")
    async def prompt_agent_validate_forge_tool(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            tool = str(payload.get("tool") or "").strip()
            arguments = validate_forge_tool_request(tool, payload.get("arguments", {}))
            return {"ok": True, "tool": tool, "arguments": arguments}
        except ForgeToolValidationError as error:
            raise HTTPException(
                status_code=422,
                detail={
                    "ok": False,
                    "error": {
                        "code": "validation_error",
                        "message": str(error),
                        "retryable": False,
                    },
                },
            ) from error

    @app.post(f"{API_PREFIX}/profiles/{{profile_id}}/connection-test")
    async def prompt_agent_profile_connection_test(profile_id: str) -> dict[str, Any]:
        try:
            profile = profiles.resolve(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        except (OSError, RuntimeError, ValueError) as error:
            raise HTTPException(
                status_code=502,
                detail={
                    "ok": False,
                    "error": {
                        "code": "secret_unavailable",
                        "message": "The stored provider credentials are unavailable.",
                        "retryable": False,
                    },
                    "profile_id": profile_id,
                },
            ) from error
        turn_id = f"connection-test:{profile_id}"
        try:
            if profile.get("runtime") == "llama-once":
                await local_runtime.start_turn(turn_id, profile)
                profile = await local_runtime.stream_profile(turn_id, profile)
            return await test_profile_connection(profile)
        except ConnectionTestError as error:
            raise HTTPException(
                status_code=error.status_code,
                detail={
                    "ok": False,
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "retryable": error.retryable,
                    },
                    "profile_id": profile_id,
                },
            ) from error
        except LocalRuntimeError as error:
            raise HTTPException(
                status_code=error.status_code,
                detail={"ok": False, "error": {"code": error.code, "message": error.message, "retryable": True}, "profile_id": profile_id},
            ) from error
        except Exception as error:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail={
                    "ok": False,
                    "error": {
                        "code": "connection_failed",
                        "message": "The provider connection test failed.",
                        "retryable": True,
                    },
                    "profile_id": profile_id,
                },
            ) from error
        finally:
            if profile.get("runtime") == "llama-once" and turn_id.startswith("connection-test:"):
                await local_runtime.stop_turn(turn_id, force=True)

    @app.post(f"{API_PREFIX}/local-runtime/start")
    async def prompt_agent_local_runtime_start(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            profile_id, turn_id = _local_runtime_request(payload)
            return await local_runtime.start_turn(turn_id, profiles.resolve(profile_id))
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        except (OSError, RuntimeError, ValueError, LocalRuntimeError) as error:
            status = error.status_code if isinstance(error, LocalRuntimeError) else 422
            message = error.message if isinstance(error, LocalRuntimeError) else str(error)
            raise HTTPException(status_code=status, detail=message) from error

    @app.post(f"{API_PREFIX}/local-runtime/stop")
    async def prompt_agent_local_runtime_stop(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            _profile_id, turn_id = _local_runtime_request(payload)
            force = payload.get("force", False)
            if not isinstance(force, bool):
                raise ValueError("force must be a boolean")
            return await local_runtime.stop_turn(turn_id, force=force)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(f"{API_PREFIX}/local-runtime/status")
    async def prompt_agent_local_runtime_status(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            profile_id, turn_id = _local_runtime_request(payload)
            return await local_runtime.status(turn_id, profile_id)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(f"{API_PREFIX}/stream")
    async def prompt_agent_stream(payload: dict[str, Any] = Body(...)):
        try:
            request = parse_stream_request(payload)
            profile = profiles.resolve(request.profile_id)
            if profile.get("runtime") == "llama-once":
                profile = await local_runtime.stream_profile(request.turn_id, profile)
        except KeyError as error:
            detail = PromptAgentError(
                "unknown_profile",
                "The selected model profile is unavailable.",
                request_id=str(payload.get("request_id") or ""),
            )
            raise HTTPException(status_code=404, detail=detail.payload()["error"]) from error
        except LocalRuntimeError as error:
            detail = PromptAgentError(error.code, error.message, request_id=str(payload.get("request_id") or ""))
            raise HTTPException(status_code=error.status_code, detail=detail.payload()["error"]) from error
        except (RuntimeError, ValueError) as error:
            detail = PromptAgentError(
                "validation_error",
                str(error),
                request_id=str(payload.get("request_id") or ""),
            )
            raise HTTPException(status_code=422, detail=detail.payload()["error"]) from error
        return StreamingResponse(
            stream_profile(request, profile),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Request-ID": request.request_id,
            },
        )


def _local_runtime_request(payload: Any) -> tuple[str, str]:
    import re

    if not isinstance(payload, dict):
        raise ValueError("request body must be an object")
    values = []
    for key in ("profile_id", "turn_id"):
        value = str(payload.get(key) or "")
        if len(value) > 96 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,95}", value):
            raise ValueError(f"{key} must be a safe identifier")
        values.append(value)
    return values[0], values[1]
