"""Per-user facts for council prompts (e.g. achievements, background)."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)

DEFAULT_FACT_LIMIT = 12


def format_student_profile_block(facts: Optional[List[Dict[str, Any]]]) -> str:
    if not facts:
        return ""
    lines = []
    for row in facts:
        t = (row.get("fact_text") or "").strip()
        if t:
            lines.append(f"- {t}")
    if not lines:
        return ""
    return (
        "FACTS THE USER HAS SHARED ABOUT THEMSELVES (treat as true for this essay; "
        "use when relevant; do not contradict or fabricate beyond these lines):\n"
        + "\n".join(lines)
        + "\n"
    )


def load_recent_user_facts(user_id: str, limit: int = DEFAULT_FACT_LIMIT) -> List[Dict[str, Any]]:
    sb = get_supabase()
    try:
        res = (
            sb.table("user_fact")
            .select("id, fact_text, source, created_at")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return list(res.data or [])
    except Exception as e:
        logger.warning("user_fact load failed for %s: %s", user_id, e)
        return []


def add_user_fact(user_id: str, fact_text: str, source: str = "manual") -> Optional[Dict[str, Any]]:
    text = (fact_text or "").strip()
    if not text or len(text) > 8000:
        return None
    if source not in ("manual", "intake", "chat", "feedback"):
        source = "manual"
    sb = get_supabase()
    try:
        res = (
            sb.table("user_fact")
            .insert({"user_id": user_id, "fact_text": text, "source": source})
            .execute()
        )
        if res.data:
            return res.data[0]
    except Exception as e:
        logger.warning("user_fact insert failed for %s: %s", user_id, e)
    return None


def list_user_facts(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    sb = get_supabase()
    try:
        res = (
            sb.table("user_fact")
            .select("id, fact_text, source, created_at")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return list(res.data or [])
    except Exception as e:
        logger.warning("user_fact list failed for %s: %s", user_id, e)
        return []


def delete_user_fact(user_id: str, fact_id: str) -> bool:
    sb = get_supabase()
    try:
        sb.table("user_fact").delete().eq("id", fact_id).eq("user_id", user_id).execute()
        return True
    except Exception as e:
        logger.warning("user_fact delete failed: %s", e)
        return False
