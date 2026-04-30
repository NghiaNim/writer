"""Persist completed essays to Supabase `essay_memory` (durable history + memory-check)."""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)

SUMMARY_MAX = 520


def derive_topic_from_message(content: str) -> str:
    """Best-effort topic line from the council handoff / chat blob."""
    if not content or not str(content).strip():
        return "Essay"
    text = str(content).strip()
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.upper().startswith("TOPIC:"):
            t = stripped.split(":", 1)[1].strip()
            if t:
                return t[:500]
    return text[:500]


def make_summary(full_essay: str) -> str:
    if not full_essay:
        return ""
    t = full_essay.strip()
    if len(t) <= SUMMARY_MAX:
        return t
    return t[: SUMMARY_MAX - 3].rstrip() + "..."


def upsert_completed_essay(
    *,
    user_id: str,
    conversation_id: str,
    session_id: Optional[str],
    essay_mode: str,
    word_target: Optional[int],
    topic: str,
    full_essay: str,
    essay_type: Optional[str] = None,
    so_what_answer: Optional[str] = None,
    core_claim: Optional[str] = None,
) -> Optional[str]:
    """Insert or update one row per (user_id, conversation_id).

    Returns the row id on success (so callers can attach extracted facts
    to it via user_fact.source_essay_id), or None on failure / empty input.
    """
    if not full_essay or not str(full_essay).strip():
        return None
    topic_clean = (topic or "").strip() or "Essay"
    summary = make_summary(full_essay)
    payload: Dict[str, Any] = {
        "user_id": user_id,
        "conversation_id": conversation_id,
        "session_id": session_id,
        "topic": topic_clean[:2000],
        "so_what_answer": (so_what_answer or None),
        "essay_type": essay_type or "general",
        "core_claim": core_claim,
        "summary": summary,
        "full_essay": full_essay,
        "essay_mode": essay_mode,
        "word_target": word_target,
    }
    sb = get_supabase()
    try:
        existing = (
            sb.table("essay_memory")
            .select("id")
            .eq("user_id", user_id)
            .eq("conversation_id", conversation_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            row_id = existing.data[0]["id"]
            update_fields = {k: v for k, v in payload.items() if k != "user_id"}
            sb.table("essay_memory").update(update_fields).eq("id", row_id).eq(
                "user_id", user_id
            ).execute()
            return str(row_id)
        else:
            res = sb.table("essay_memory").insert(payload).execute()
            if res.data:
                return str(res.data[0].get("id"))
            return None
    except Exception as e:
        logger.warning("essay_memory upsert failed user=%s conv=%s: %s", user_id, conversation_id, e)
        return None


def save_essay_feedback(
    *,
    user_id: str,
    conversation_id: str,
    rating: Optional[int],
    feedback_text: Optional[str],
) -> bool:
    """Attach feedback to the essay_memory row for this conversation."""
    if not conversation_id:
        return False
    text = (feedback_text or "").strip() or None
    if rating is None and not text:
        return False
    sb = get_supabase()
    try:
        res = (
            sb.table("essay_memory")
            .select("id")
            .eq("user_id", user_id)
            .eq("conversation_id", conversation_id)
            .limit(1)
            .execute()
        )
        if not res.data:
            return False
        from datetime import datetime, timezone

        patch: Dict[str, Any] = {
            "feedback_at": datetime.now(timezone.utc).isoformat(),
        }
        if rating is not None:
            patch["feedback_rating"] = rating
        if text:
            patch["feedback_text"] = text[:8000]
        sb.table("essay_memory").update(patch).eq("id", res.data[0]["id"]).execute()
        return True
    except Exception as e:
        logger.warning("essay_memory feedback failed user=%s: %s", user_id, e)
        return False
