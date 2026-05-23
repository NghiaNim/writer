"""Essay sessions router.

Tracks the intake state per user (topic → questions → core idea → voice).
Every step writes to the `essay_sessions` table in Supabase so a user
can refresh and resume.

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
import re
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

    `step` and `core_idea` are added as part of the resume-in-progress
    work — the client autosaves both as the user moves through the flow
    so reload lands them right back where they were.
    """

    topic: Optional[str] = None
    so_what_answer: Optional[str] = None
    essay_type: Optional[str] = None
    audience: Optional[str] = None
    path: Optional[Literal["interactive", "draft"]] = None
    conversation: Optional[List[Dict[str, Any]]] = None
    draft: Optional[str] = None
    status: Optional[str] = None
    word_target: Optional[int] = Field(None, ge=50, le=5000)
    council_config: Optional[Dict[str, Any]] = None
    conversation_id: Optional[str] = None
    step: Optional[
        Literal["topic", "brainstorm", "draft", "questions", "core_idea", "timeline", "voice"]
    ] = None
    core_idea: Optional[str] = None


class SessionRow(BaseModel):
    id: str
    user_id: str
    topic: Optional[str] = None
    so_what_answer: Optional[str] = None
    essay_type: Optional[str] = None
    audience: Optional[str] = None
    path: Optional[str] = None
    conversation: List[Dict[str, Any]] = []
    draft: Optional[str] = None
    status: str = "in_progress"
    word_target: Optional[int] = None
    council_config: Optional[Dict[str, Any]] = None
    conversation_id: Optional[str] = None
    step: Optional[str] = None
    core_idea: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SessionListItem(BaseModel):
    """Compact session summary for the sidebar's drafts-in-progress list.

    The sidebar doesn't need the full `conversation` JSON or council
    config — just enough to render a row and route a click. Keeping the
    response thin matters because users may have dozens of drafts.
    """

    id: str
    topic: Optional[str] = None
    audience: Optional[str] = None
    essay_type: Optional[str] = None
    step: Optional[str] = None
    status: str = "in_progress"
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
        audience=row.get("audience"),
        path=row.get("path"),
        conversation=row.get("conversation") or [],
        draft=row.get("draft"),
        status=row.get("status") or "in_progress",
        word_target=row.get("word_target"),
        council_config=row.get("council_config"),
        conversation_id=row.get("conversation_id"),
        step=row.get("step"),
        core_idea=row.get("core_idea"),
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


@router.get("", response_model=List[SessionListItem])
async def list_sessions(
    status: Optional[str] = Query("in_progress"),
    limit: int = Query(20, ge=1, le=100),
    user: AuthUser = Depends(get_current_user),
):
    """List the caller's recent essay sessions.

    Powers the sidebar's "Drafts in progress" section. Filters by status
    (default 'in_progress') and orders newest-first. We deliberately
    return only the slim `SessionListItem` shape — full conversation
    JSON is hauled in only when the user clicks one (via GET /{id}).
    """
    supabase = get_supabase()
    # We fetch `conversation` and `core_idea` even though they're not in
    # the response shape — we use them to DERIVE the step when the
    # persisted `step` column is null (migration 010 not applied, or row
    # was created before the column existed). The derived step is what
    # the sidebar shows so users always see an accurate "where I left off"
    # marker even on a fresh DB.
    select_with_step = "id, topic, audience, essay_type, step, status, conversation, core_idea, updated_at"
    select_without_step = "id, topic, audience, essay_type, status, conversation, core_idea, updated_at"

    def _run(select_cols: str):
        q = (
            supabase.table("essay_sessions")
            .select(select_cols)
            .eq("user_id", user.id)
            .order("updated_at", desc=True)
            .limit(limit)
        )
        if status:
            q = q.eq("status", status)
        return q.execute()

    # Try the full select first. If migration 010 hasn't been applied yet
    # the `step` column won't exist — fall back to a select without it
    # so the sidebar still surfaces in-progress drafts. The `step` field
    # is just null until the migration lands; resume still works via the
    # full row fetch in GET /sessions/{id}.
    try:
        result = _run(select_with_step)
    except Exception as e:
        msg = str(e).lower()
        if "step" in msg and "does not exist" in msg:
            logger.warning(
                "list_sessions: 'step' column missing — fallback select "
                "(apply migration 010_essay_session_step.sql to enable)."
            )
            try:
                result = _run(select_without_step)
            except Exception as e2:
                logger.warning(f"Failed to list sessions (fallback) for {user.id}: {e2}")
                return []
        else:
            logger.warning(f"Failed to list sessions for {user.id}: {e}")
            return []

    items: List[SessionListItem] = []
    for r in (result.data or []):
        items.append(
            SessionListItem(
                id=str(r["id"]),
                topic=r.get("topic"),
                audience=r.get("audience"),
                essay_type=r.get("essay_type"),
                step=_derive_step_from_row(r),
                status=r.get("status") or "in_progress",
                updated_at=str(r["updated_at"]) if r.get("updated_at") else None,
            )
        )
    return items


def _derive_step_from_row(row: Dict[str, Any]) -> Optional[str]:
    """Infer the user's farthest step from session data.

    Used as a fallback when the persisted `step` column is null (e.g.
    migration 010 hasn't been applied yet, or the row was created before
    that column existed). The persisted value always wins when present.

    Logic — most-advanced inference based on what's filled in:

        status == 'ready'         → user finished, council ran  → 'voice'
        conversation has timeline → past Step 4                  → 'voice'
        core_idea has content     → past Step 3                  → 'timeline'
        conversation has Q&A      → past Step 2                  → 'core_idea'
        topic has content         → on Step 1                    → 'topic'
        otherwise                                                 → 'topic'
    """
    persisted = (row.get("step") or "").strip()
    if persisted:
        return persisted

    status = (row.get("status") or "").strip().lower()
    if status == "ready":
        return "voice"

    conversation = row.get("conversation") or []
    has_timeline = False
    has_qa = False
    if isinstance(conversation, list):
        for item in conversation:
            if not isinstance(item, dict):
                continue
            if item.get("kind") == "timeline" and item.get("events"):
                has_timeline = True
            elif item.get("question") is not None:
                has_qa = True

    if has_timeline:
        return "voice"

    core_idea = (row.get("core_idea") or "").strip()
    if core_idea:
        return "timeline"

    if has_qa:
        return "core_idea"

    topic = (row.get("topic") or "").strip()
    if topic:
        return "topic"

    return "topic"


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
    """Surface past essays whose topic looks similar.

    Conservative implementation: case-insensitive substring match against
    `topic` keywords, ordered newest-first, capped at 5. Swap in semantic
    search once we have embeddings.
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

    # PostgREST's or_ filter is a comma-separated string of conditions,
    # with parentheses grouping. If a raw token contains any of those
    # metacharacters (or ilike wildcards), the clause silently breaks
    # apart and the query returns 0 rows — so memory_check stops
    # warning the user about prior essays on the same topic. Strip them.
    def _safe_token(t: str) -> str:
        cleaned = re.sub(r"[,()*%_:\\]", " ", t).strip()
        return cleaned[:80]

    safe_tokens = [s for s in (_safe_token(t) for t in tokens) if len(s) >= 4]
    if not safe_tokens:
        return MemoryCheckResponse(found=False, matches=[])

    query = (
        supabase.table("essay_memory")
        .select("id, conversation_id, topic, summary, created_at")
        .eq("user_id", user.id)
        .order("created_at", desc=True)
        .limit(5)
    )

    or_clause = ",".join(f"topic.ilike.%{t}%" for t in safe_tokens)
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
    if "audience" in payload and isinstance(payload["audience"], str):
        payload["audience"] = payload["audience"].strip() or None

    supabase = get_supabase()

    def _run(p: Dict[str, Any]):
        return (
            supabase.table("essay_sessions")
            .update(p)
            .eq("id", session_id)
            .eq("user_id", user.id)
            .execute()
        )

    try:
        result = _run(payload)
    except Exception as e:
        msg = str(e).lower()
        # Migration-010 fallback: if the `step` column hasn't been added
        # yet, the patch fails. Strip `step` and retry so the rest of
        # the user's data (topic, audience, conversation, core_idea)
        # still persists. The frontend will re-derive `step` from
        # whatever data shape we round-trip back.
        if "step" in payload and "step" in msg and "schema cache" in msg:
            logger.warning(
                "update_session: 'step' column missing — retrying without it "
                "(apply migration 010_essay_session_step.sql to enable)."
            )
            payload_no_step = {k: v for k, v in payload.items() if k != "step"}
            if not payload_no_step:
                # The only field was `step` and we can't persist it. Treat
                # as a no-op so the autosave loop doesn't crash.
                return _coerce_session(_own_session_or_404(session_id, user.id))
            try:
                result = _run(payload_no_step)
            except Exception as e2:
                logger.warning(f"Failed to update session (fallback) {session_id} for {user.id}: {e2}")
                raise HTTPException(status_code=500, detail="Failed to update session")
        else:
            logger.warning(f"Failed to update session {session_id} for {user.id}: {e}")
            raise HTTPException(status_code=500, detail="Failed to update session")
    if not result.data:
        raise HTTPException(status_code=404, detail="Session not found")
    return _coerce_session(result.data[0])


@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Delete an essay session the caller owns.

    Used by the sidebar's trash icon on the drafts-in-progress list.
    Cascade behavior depends on the FK constraints — `conversation_id`
    on the session is a soft pointer; deleting a session does NOT
    delete the resulting conversation or its essay_memory row.
    """
    _own_session_or_404(session_id, user.id)
    supabase = get_supabase()
    try:
        supabase.table("essay_sessions").delete().eq("id", session_id).eq(
            "user_id", user.id
        ).execute()
    except Exception as e:
        logger.warning(f"Failed to delete session {session_id} for {user.id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete session")
    return {"ok": True}
