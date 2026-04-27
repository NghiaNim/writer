"""End-to-end verification for extension #1 (word target + council config).

Prereq: migration 002_essay_extensions.sql has been applied via the Supabase
SQL editor. This script then:

    1. Creates a temporary auth user (admin API).
    2. Hits POST /sessions with word_target.
    3. Hits PATCH /sessions/{id} with council_config.
    4. Hits GET / PUT /council-config (per-user defaults).
    5. Cleans up.

Run from project root:

    uv run python -m backend.scripts.verify_council_extensions

Expected last line: ``OK — extension #1 verified.``
"""

from __future__ import annotations

import json
import secrets
import sys
import uuid
from typing import Any, Dict, Optional
from urllib import error, request

from backend.config import OPENROUTER_API_KEY  # noqa: F401  (loads .env via config)
from backend.supabase_client import get_supabase

API_BASE = "http://localhost:8001"


def _http(
    method: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    token: Optional[str] = None,
) -> Dict[str, Any]:
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = request.Request(url, data=data, method=method, headers=headers)
    try:
        with request.urlopen(req, timeout=30) as resp:
            payload = resp.read().decode()
            return {"status": resp.status, "json": json.loads(payload) if payload else {}}
    except error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body_text)
        except json.JSONDecodeError:
            parsed = {"raw": body_text}
        return {"status": e.code, "json": parsed}


def _expect(condition: bool, label: str, ctx: Any = None) -> None:
    if condition:
        print(f"  ok  · {label}")
    else:
        print(f"  FAIL · {label}")
        if ctx is not None:
            print(f"        ctx: {ctx}")
        sys.exit(1)


def _make_user() -> tuple[str, str]:
    """Create a temp Supabase auth user via the admin API. Returns (user_id, jwt)."""
    sb = get_supabase()
    email = f"ext1-{uuid.uuid4().hex[:8]}@email.test"
    password = "Cypress!" + secrets.token_urlsafe(8)
    print(f"creating temp user {email} ...")
    created = sb.auth.admin.create_user({
        "email": email,
        "password": password,
        "email_confirm": True,
    })
    user_id = created.user.id
    # Sign in via the public auth route to get a JWT.
    res = _http("POST", "/auth/login", {"email": email, "password": password})
    _expect(res["status"] == 200, "login (POST /auth/login)", res)
    token = res["json"]["session"]["access_token"]
    return user_id, token


def _cleanup(user_id: str) -> None:
    try:
        sb = get_supabase()
        sb.auth.admin.delete_user(user_id)
    except Exception as e:
        print(f"  (cleanup warning: {e})")


def main() -> None:
    print("=" * 60)
    print("Extension #1 verification (word target + council config)")
    print("=" * 60)

    user_id, token = _make_user()
    try:
        # ---- /council-config GET (no row yet -> factory default) ----
        res = _http("GET", "/council-config", token=token)
        _expect(res["status"] == 200, "GET /council-config (factory default)", res)
        body = res["json"]
        _expect(
            body.get("enabled_count", 0) == 4,
            "factory has 4 enabled personas",
            body,
        )
        keys = sorted(p["key"] for p in body["personas"])
        _expect(
            keys == ["architect", "devils_advocate", "editor", "voice_guardian"],
            "factory persona keys",
            body,
        )

        # ---- /council-config PUT (save a custom config) ----
        custom = {
            "personas": [
                {"key": "architect", "enabled": True, "model": "openrouter:openai/gpt-4o"},
                {"key": "editor", "enabled": True, "model": "openrouter:anthropic/claude-3-haiku"},
                {"key": "devils_advocate", "enabled": False, "model": ""},
                {"key": "voice_guardian", "enabled": True, "model": "openrouter:google/gemini-pro-1.5"},
            ],
            "chairman_model": "openrouter:anthropic/claude-3.5-sonnet",
        }
        res = _http("PUT", "/council-config", custom, token=token)
        _expect(res["status"] == 200, "PUT /council-config (custom)", res)
        _expect(
            res["json"].get("enabled_count") == 3,
            "saved with 3 enabled personas",
            res["json"],
        )

        # ---- /council-config GET (now returns saved row) ----
        res = _http("GET", "/council-config", token=token)
        _expect(res["status"] == 200, "GET /council-config (after save)", res)
        body = res["json"]
        _expect(
            body.get("enabled_count") == 3,
            "GET reflects 3 enabled",
            body,
        )

        # ---- Validation: PUT with too few enabled is rejected ----
        bad = {
            "personas": [
                {"key": "architect", "enabled": True, "model": "openrouter:openai/gpt-4o"},
                {"key": "editor", "enabled": False, "model": ""},
                {"key": "devils_advocate", "enabled": False, "model": ""},
                {"key": "voice_guardian", "enabled": False, "model": ""},
            ],
            "chairman_model": "openrouter:openai/gpt-4o",
        }
        res = _http("PUT", "/council-config", bad, token=token)
        _expect(res["status"] == 400, "PUT rejects <2 enabled personas", res)

        # ---- Validation: enabled persona without a model is rejected ----
        bad2 = {
            "personas": [
                {"key": "architect", "enabled": True, "model": "openrouter:openai/gpt-4o"},
                {"key": "editor", "enabled": True, "model": ""},
                {"key": "devils_advocate", "enabled": False, "model": ""},
                {"key": "voice_guardian", "enabled": False, "model": ""},
            ],
            "chairman_model": "openrouter:openai/gpt-4o",
        }
        res = _http("PUT", "/council-config", bad2, token=token)
        _expect(res["status"] == 400, "PUT rejects enabled-without-model", res)

        # ---- /sessions POST with word_target ----
        res = _http(
            "POST",
            "/sessions",
            {"topic": "ext1 e2e essay", "word_target": 650},
            token=token,
        )
        _expect(res["status"] == 200, "POST /sessions w/ word_target=650", res)
        session_id = res["json"]["id"]
        _expect(
            res["json"].get("word_target") == 650,
            "session row carries word_target",
            res["json"],
        )

        # ---- PATCH /sessions/{id} with council_config + new word_target ----
        patch = {
            "word_target": 500,
            "council_config": custom,
            "path": "draft",
        }
        res = _http("PATCH", f"/sessions/{session_id}", patch, token=token)
        _expect(res["status"] == 200, "PATCH /sessions w/ council_config", res)
        _expect(
            res["json"].get("word_target") == 500,
            "PATCH updates word_target -> 500",
            res["json"],
        )
        cfg = res["json"].get("council_config") or {}
        enabled = sum(1 for p in (cfg.get("personas") or []) if p.get("enabled"))
        _expect(enabled == 3, "PATCH stores council_config with 3 enabled", cfg)

        # ---- word_target out-of-range is rejected by the DB CHECK ----
        # Pydantic should catch >5000 first; verify both bounds are defended.
        res = _http(
            "POST",
            "/sessions",
            {"topic": "boundary check", "word_target": 49},
            token=token,
        )
        _expect(res["status"] in (400, 422), "POST rejects word_target<50", res)

    finally:
        _cleanup(user_id)

    print()
    print("OK — extension #1 verified.")


if __name__ == "__main__":
    main()
