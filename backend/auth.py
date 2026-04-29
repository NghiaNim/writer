"""Authentication router and dependencies (Phase 1).

Wraps Supabase auth so the rest of the app can stay framework-agnostic:
    POST /auth/signup    create user + return session
    POST /auth/login     password sign-in + return session
    POST /auth/logout    revoke the user's refresh token
    GET  /auth/me        whoami (validates the bearer token)

The `get_current_user` dependency is what every protected endpoint will use
to identify the caller. It expects an `Authorization: Bearer <jwt>` header
and validates the JWT against Supabase.
"""

from __future__ import annotations

import logging
from typing import Optional

import posthog
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

from .supabase_client import get_supabase, get_supabase_for_auth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class SignupRequest(BaseModel):
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthUser(BaseModel):
    id: str
    email: Optional[str] = None
    created_at: Optional[str] = None


class AuthResponse(BaseModel):
    """Returned by signup and login.

    `access_token` is None when the project requires email confirmation and
    the user has not yet confirmed. The frontend uses this to display a
    "check your email" message instead of logging the user in.
    """

    access_token: Optional[str]
    refresh_token: Optional[str] = None
    user: Optional[AuthUser] = None
    needs_email_confirmation: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _user_to_dict(user) -> Optional[AuthUser]:
    if user is None:
        return None
    return AuthUser(
        id=str(user.id),
        email=getattr(user, "email", None),
        created_at=str(getattr(user, "created_at", "")) or None,
    )


def _extract_bearer_token(authorization: Optional[str]) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be 'Bearer <token>'",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return parts[1]


# ---------------------------------------------------------------------------
# Dependency: get_current_user
# ---------------------------------------------------------------------------


async def get_current_user(authorization: Optional[str] = Header(None)) -> AuthUser:
    """Validate the bearer JWT and return the authenticated user.

    Used by every protected endpoint:
        @router.get("/secret")
        async def secret(user: AuthUser = Depends(get_current_user)):
            ...
    """
    token = _extract_bearer_token(authorization)
    supabase = get_supabase()
    try:
        result = supabase.auth.get_user(token)
    except Exception as e:
        logger.info(f"Auth: rejected token (validation error): {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = getattr(result, "user", None)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    auth_user = _user_to_dict(user)
    if auth_user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return auth_user


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/signup", response_model=AuthResponse)
async def signup(body: SignupRequest):
    """Create a Supabase user and return a session if email confirmation is off."""
    # Use the dedicated auth client — sign_up mutates PostgREST auth headers.
    supabase = get_supabase_for_auth()
    try:
        result = supabase.auth.sign_up({"email": body.email, "password": body.password})
    except Exception as e:
        logger.info(f"Signup failed for {body.email}: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    session = getattr(result, "session", None)
    user = getattr(result, "user", None)

    if user is not None:
        user_id = str(user.id)
        posthog.capture(
            user_id,
            "user_signed_up",
            properties={"signup_method": "email"},
        )

    # If email confirmation is enabled in the Supabase project, signup returns
    # a user but no session. The frontend handles this case explicitly.
    if session is None:
        return AuthResponse(
            access_token=None,
            refresh_token=None,
            user=_user_to_dict(user),
            needs_email_confirmation=user is not None,
        )

    return AuthResponse(
        access_token=session.access_token,
        refresh_token=getattr(session, "refresh_token", None),
        user=_user_to_dict(user),
        needs_email_confirmation=False,
    )


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest):
    """Password sign-in. Returns a session token on success."""
    # Use the dedicated auth client — sign_in_with_password mutates PostgREST
    # auth headers and would silently break RLS-bypass on the admin client.
    supabase = get_supabase_for_auth()
    try:
        result = supabase.auth.sign_in_with_password(
            {"email": body.email, "password": body.password}
        )
    except Exception as e:
        logger.info(f"Login failed for {body.email}: {e}")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    session = getattr(result, "session", None)
    user = getattr(result, "user", None)
    if session is None or user is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    posthog.capture(
        str(user.id),
        "user_logged_in",
        properties={"login_method": "email"},
    )

    return AuthResponse(
        access_token=session.access_token,
        refresh_token=getattr(session, "refresh_token", None),
        user=_user_to_dict(user),
        needs_email_confirmation=False,
    )


@router.post("/logout")
async def logout(authorization: Optional[str] = Header(None)):
    """Revoke the user's refresh token server-side.

    The frontend also drops its in-memory token, so this is belt-and-suspenders.
    Returns 200 even if the token is already invalid; logging out should never
    surface an error to the user.
    """
    token = _extract_bearer_token(authorization)
    supabase = get_supabase()
    try:
        # admin.sign_out revokes the refresh token associated with this JWT.
        supabase.auth.admin.sign_out(token)
    except Exception as e:
        # Already-invalid tokens are fine; log and move on.
        logger.info(f"Logout: server-side revoke skipped ({e})")
    return {"status": "ok"}


@router.get("/me", response_model=AuthUser)
async def me(user: AuthUser = Depends(get_current_user)):
    """Return the currently authenticated user."""
    return user
