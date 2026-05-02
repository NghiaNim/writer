"""Essay sessions router (Phase 3).

Tracks the 3-step input flow state per user. Every step writes to the
`essay_sessions` table in Supabase so a user can refresh and resume.

Endpoints (all require `Authorization: Bearer <jwt>`):

    POST   /sessions                  Step 1: create a session with the topic
    GET    /sessions/{id}             read a session (must belong to caller)
    PATCH  /sessions/{id}             Step 2 / Step 3: partial update
    GET    /sessions/memory-check     "have I written about this before?"

The backend uses the Supabase service-role client which bypasses RLS, so we
always scope queries by the JWT-validated `user_id` in app code. The RLS
policies are belt-and-suspenders against direct anon-key access.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .auth import AuthUser, get_current_user
from .supabase_client import get_supabase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["sessions"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class CreateSessionRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=500)
    essay_type: Optional[str] = "general"
    word_target: Optional[int] = Field(None, ge=50, le=5000)


class UpdateSessionRequest(BaseModel):
    """Partial update — only fields the client sends are written.

    `path` is constrained to the same values as the DB CHECK constraint so we
    surface validation errors before they hit Postgres.

    `word_target` and `council_config` are extension #1 (per-essay overrides).
    The structural shape of `council_config` is validated via PUT /council-config;
    this endpoint accepts whatever JSON the client sends, since the resolver
    in council.py is tolerant of partial / malformed configs.
    """

    topic: Optional[str] = None
    so_what_answer: Optional[str] = None
    essay_type: Optional[str] = None
    path: Optional[Literal["interactive", "draft"]] = None
    conversation: Optional[List[Dict[str, Any]]] = None
    draft: Optional[str] = None
    status: Optional[str] = None
    word_target: Optional[int] = Field(None, ge=50, le=5000)
    council_config: Optional[Dict[str, Any]] = None
    conversation_id: Optional[str] = None


class SessionRow(BaseModel):
    id: str
    user_id: str
    topic: Optional[str] = None
    so_what_answer: Optional[str] = None
    essay_type: Optional[str] = None
    path: Optional[str] = None
    conversation: List[Dict[str, Any]] = []
    draft: Optional[str] = None
    status: str = "in_progress"
    word_target: Optional[int] = None
    council_config: Optional[Dict[str, Any]] = None
    conversation_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class MemoryMatch(BaseModel):
    id: str
    conversation_id: Optional[str] = None
    topic: str
    summary: Optional[str] = None
    created_at: Optional[str] = None


class MemoryCheckResponse(BaseModel):
    found: bool
    matches: List[MemoryMatch] = []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coerce_session(row: Dict[str, Any]) -> SessionRow:
    """Normalize Supabase row JSON into a SessionRow."""
    return SessionRow(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        topic=row.get("topic"),
        so_what_answer=row.get("so_what_answer"),
        essay_type=row.get("essay_type"),
        path=row.get("path"),
        conversation=row.get("conversation") or [],
        draft=row.get("draft"),
        status=row.get("status") or "in_progress",
        word_target=row.get("word_target"),
        council_config=row.get("council_config"),
        conversation_id=row.get("conversation_id"),
        created_at=str(row["created_at"]) if row.get("created_at") else None,
        updated_at=str(row["updated_at"]) if row.get("updated_at") else None,
    )


def _own_session_or_404(session_id: str, user_id: str) -> Dict[str, Any]:
    """Fetch a session and verify it belongs to the caller, else 404.

    Returns the raw row dict so callers can immediately re-use it.
    """
    supabase = get_supabase()
    result = (
        supabase.table("essay_sessions")
        .select("*")
        .eq("id", session_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Session not found")
    return result.data[0]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("", response_model=SessionRow)
async def create_session(
    body: CreateSessionRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Step 1: create a session row with the user's topic."""
    supabase = get_supabase()
    payload = {
        "user_id": user.id,
        "topic": body.topic.strip(),
        "essay_type": (body.essay_type or "general").strip() or "general",
        "status": "in_progress",
    }
    if body.word_target is not None:
        payload["word_target"] = body.word_target
    try:
        result = supabase.table("essay_sessions").insert(payload).execute()
    except Exception as e:
        logger.warning(f"Failed to create session for {user.id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to create session")
    if not result.data:
        raise HTTPException(status_code=500, detail="Session not created")
    return _coerce_session(result.data[0])


@router.get("/memory-check", response_model=MemoryCheckResponse)
async def memory_check(
    topic: str = Query(..., min_length=1, max_length=500),
    user: AuthUser = Depends(get_current_user),
):
    """Phase 3: surface past essays whose topic looks similar.

    Implementation is intentionally conservative — case-insensitive substring
    match against `topic` keywords, ordered newest-first, capped at 5. Phase
    5+ can swap in semantic search once we have embeddings.
    """
    supabase = get_supabase()
    needle = topic.strip()
    if not needle:
        return MemoryCheckResponse(found=False, matches=[])

    # Build a list of substrings to OR across. Splitting on whitespace and
    # keeping tokens >= 4 chars filters out filler like "the", "and".
    tokens = [t for t in needle.split() if len(t) >= 4][:6]
    if not tokens:
        # Fall back to the whole topic string.
        tokens = [needle]

    query = (
        supabase.table("essay_memory")
        .select("id, conversation_id, topic, summary, created_at")
        .eq("user_id", user.id)
        .order("created_at", desc=True)
        .limit(5)
    )

    # PostgREST .or_() takes a comma-separated string of conditions.
    or_clause = ",".join(f"topic.ilike.%{t}%" for t in tokens)
    try:
        result = query.or_(or_clause).execute()
    except Exception as e:
        # Don't let memory-check crash the flow — it's a non-blocking
        # convenience surface for the user.
        logger.warning(f"memory-check failed for {user.id}: {e}")
        return MemoryCheckResponse(found=False, matches=[])

    matches = [
        MemoryMatch(
            id=str(r["id"]),
            conversation_id=str(r["conversation_id"]) if r.get("conversation_id") else None,
            topic=r.get("topic") or "",
            summary=r.get("summary"),
            created_at=str(r["created_at"]) if r.get("created_at") else None,
        )
        for r in (result.data or [])
    ]
    return MemoryCheckResponse(found=bool(matches), matches=matches)


@router.get("/{session_id}", response_model=SessionRow)
async def get_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Read a session. 404 if it doesn't exist OR belongs to someone else."""
    row = _own_session_or_404(session_id, user.id)
    return _coerce_session(row)


@router.patch("/{session_id}", response_model=SessionRow)
async def update_session(
    session_id: str,
    body: UpdateSessionRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Step 2 / Step 3: partial update on a session the caller owns."""
    # Verify ownership before writing — RLS would catch this anyway with the
    # anon key, but we use the service role.
    _own_session_or_404(session_id, user.id)

    payload = body.model_dump(exclude_none=True)
    if not payload:
        # Nothing to update — just return the current row.
        return _coerce_session(_own_session_or_404(session_id, user.id))

    if "topic" in payload and isinstance(payload["topic"], str):
        payload["topic"] = payload["topic"].strip()

    supabase = get_supabase()
    try:
        result = (
            supabase.table("essay_sessions")
            .update(payload)
            .eq("id", session_id)
            .eq("user_id", user.id)
            .execute()
        )
    except Exception as e:
        logger.warning(f"Failed to update session {session_id} for {user.id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to update session")
    if not result.data:
        raise HTTPException(status_code=404, detail="Session not found")
    return _coerce_session(result.data[0])
