"""Supabase clients (Phase 1: Auth).

Two service-role clients live here. They share the same secret but are
separate Python instances so their internal state can't pollute each other:

  * `get_supabase()`       — pristine admin / DB client. Use for table
                             operations and `auth.admin.*` calls. NEVER call
                             `sign_up` / `sign_in_with_password` on this client.
  * `get_supabase_for_auth()` — used **only** for password sign-up / sign-in.
                                Those calls mutate the client's PostgREST auth
                                header to the freshly-signed-in user's JWT,
                                which would silently break RLS-bypass for any
                                subsequent table query.

We don't read auth state back from the auth client — we extract the access
token from the call's return value — so concurrent sign-ins are safe.

Required environment variables (loaded from `backend/.env`):
    SUPABASE_URL         The project URL (e.g. https://xyz.supabase.co)
    SUPABASE_SECRET_KEY  The service role / secret key
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from supabase import Client, create_client

logger = logging.getLogger(__name__)

# Load env from backend/.env explicitly (not project root). dotenv.load_dotenv()
# with no args walks up from cwd, which won't find backend/.env when the app is
# launched from the project root.
_BACKEND_ENV = Path(__file__).resolve().parent / ".env"
load_dotenv(_BACKEND_ENV)


def _build_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY")
    if not url or not key:
        raise RuntimeError(
            "Supabase is not configured. Set SUPABASE_URL and "
            "SUPABASE_SECRET_KEY in backend/.env."
        )
    return create_client(url, key)


# Two singletons — see module docstring for why they are separate.
_db_client: Client | None = None
_auth_client: Client | None = None


def get_supabase() -> Client:
    """Pristine admin / DB client (table ops + `auth.admin.*` only).

    Do NOT call `sign_up` or `sign_in_with_password` on this client — those
    mutate its PostgREST auth header to the user's JWT, breaking RLS-bypass.
    Use `get_supabase_for_auth()` for password sign-up / sign-in instead.
    """
    global _db_client
    if _db_client is None:
        _db_client = _build_client()
        logger.info("Supabase admin client initialized")
    return _db_client


def get_supabase_for_auth() -> Client:
    """Service-role client used only for password sign-up / sign-in.

    Calls to `auth.sign_up` and `auth.sign_in_with_password` mutate this
    client's PostgREST auth header. We extract the access token from the
    call's return value rather than reading client state, so concurrent
    sign-ins are safe.
    """
    global _auth_client
    if _auth_client is None:
        _auth_client = _build_client()
        logger.info("Supabase auth client initialized")
    return _auth_client
