"""Per-user facts for council prompts (e.g. achievements, background).

Phase: auto-extraction. Facts now carry a `category` so the council can
inject biographical/voice memory cleanly grouped, and a `source_essay_id`
so we can refresh facts when an essay is re-run instead of accumulating
near-duplicates.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)

DEFAULT_FACT_LIMIT = 24

VALID_CATEGORIES = (
    "biography",
    "experience",
    "belief",
    "interest",
    "achievement",
    "relationship",
    "reference",
    "general",
)

VALID_SOURCES = ("manual", "intake", "chat", "feedback", "essay")

# Human-readable section headers for prompt-block rendering. Order matters —
# biographical context first, then experience, then beliefs/interests, then
# the more decorative categories.
_CATEGORY_HEADERS: List[Tuple[str, str]] = [
    ("biography", "Biography"),
    ("experience", "Experiences"),
    ("belief", "Beliefs and values"),
    ("interest", "Interests"),
    ("achievement", "Achievements"),
    ("relationship", "Relationships"),
    ("reference", "Writers / works they admire"),
    ("general", "Other"),
]


def _normalize_category(cat: Optional[str]) -> str:
    c = (cat or "general").strip().lower()
    return c if c in VALID_CATEGORIES else "general"


def _normalize_source(src: Optional[str]) -> str:
    s = (src or "manual").strip().lower()
    return s if s in VALID_SOURCES else "manual"


def _normalize_for_dedupe(text: str) -> str:
    """Lowercase + collapse whitespace + strip punctuation for dedupe comparison."""
    t = text.lower().strip()
    t = re.sub(r"[\s]+", " ", t)
    t = re.sub(r"[^\w\s]", "", t)
    return t


def format_student_profile_block(facts: Optional[List[Dict[str, Any]]]) -> str:
    """Render the user's known facts grouped by category for prompt injection."""
    if not facts:
        return ""

    grouped: Dict[str, List[str]] = {cat: [] for cat, _ in _CATEGORY_HEADERS}
    for row in facts:
        text = (row.get("fact_text") or "").strip()
        if not text:
            continue
        cat = _normalize_category(row.get("category"))
        grouped.setdefault(cat, []).append(text)

    sections: List[str] = []
    for cat, header in _CATEGORY_HEADERS:
        items = grouped.get(cat) or []
        if not items:
            continue
        sections.append(f"{header}:")
        for item in items:
            sections.append(f"  - {item}")
        sections.append("")

    if not sections:
        return ""

    intro = (
        "FACTS THE USER HAS SHARED ABOUT THEMSELVES (treat as true for this essay; "
        "use when relevant; do not contradict or fabricate beyond these lines):"
    )
    return intro + "\n" + "\n".join(sections)


def load_recent_user_facts(
    user_id: str, limit: int = DEFAULT_FACT_LIMIT
) -> List[Dict[str, Any]]:
    sb = get_supabase()
    try:
        res = (
            sb.table("user_fact")
            .select("id, fact_text, category, source, source_essay_id, created_at")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return list(res.data or [])
    except Exception as e:
        logger.warning("user_fact load failed for %s: %s", user_id, e)
        return []


def add_user_fact(
    user_id: str,
    fact_text: str,
    source: str = "manual",
    category: str = "general",
    source_essay_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    text = (fact_text or "").strip()
    if not text or len(text) > 8000:
        return None
    payload: Dict[str, Any] = {
        "user_id": user_id,
        "fact_text": text,
        "source": _normalize_source(source),
        "category": _normalize_category(category),
    }
    if source_essay_id:
        payload["source_essay_id"] = source_essay_id

    sb = get_supabase()
    try:
        res = sb.table("user_fact").insert(payload).execute()
        if res.data:
            return res.data[0]
    except Exception as e:
        logger.warning("user_fact insert failed for %s: %s", user_id, e)
    return None


def list_user_facts(user_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    sb = get_supabase()
    try:
        res = (
            sb.table("user_fact")
            .select("id, fact_text, category, source, source_essay_id, created_at")
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


def delete_facts_for_essay(user_id: str, essay_id: str) -> int:
    """Remove all facts that were extracted from a given essay row.

    Used when an essay is re-run so the new extraction replaces the old
    one instead of stacking near-duplicates. Returns count deleted, or 0
    on any failure.
    """
    if not essay_id:
        return 0
    sb = get_supabase()
    try:
        res = (
            sb.table("user_fact")
            .delete()
            .eq("user_id", user_id)
            .eq("source_essay_id", essay_id)
            .execute()
        )
        return len(res.data or [])
    except Exception as e:
        logger.warning("user_fact delete-by-essay failed for %s: %s", user_id, e)
        return 0


def bulk_insert_user_facts(
    user_id: str,
    items: Iterable[Dict[str, Any]],
    *,
    source: str = "essay",
    source_essay_id: Optional[str] = None,
) -> int:
    """Insert many facts in one round-trip, deduped against existing rows.

    Each item is a dict with keys `category` and `fact_text`. The dedupe
    comparison is case- and punctuation-insensitive, against the user's
    most recent ~200 facts. Returns the number of rows actually inserted.
    """
    cleaned: List[Dict[str, Any]] = []
    seen_in_batch: set[str] = set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("fact_text") or "").strip()
        if not text or len(text) > 8000:
            continue
        cat = _normalize_category(item.get("category"))
        norm = _normalize_for_dedupe(text)
        if not norm or norm in seen_in_batch:
            continue
        seen_in_batch.add(norm)
        row: Dict[str, Any] = {
            "user_id": user_id,
            "fact_text": text,
            "source": _normalize_source(source),
            "category": cat,
        }
        if source_essay_id:
            row["source_essay_id"] = source_essay_id
        cleaned.append(row)

    if not cleaned:
        return 0

    # Dedupe against existing facts. We pull a generous window of recent
    # facts rather than all rows — for a user with thousands of facts the
    # window stays bounded, and near-duplicates would mostly be recent.
    sb = get_supabase()
    try:
        existing = (
            sb.table("user_fact")
            .select("fact_text")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        existing_norms = {
            _normalize_for_dedupe(r.get("fact_text") or "")
            for r in (existing.data or [])
        }
    except Exception as e:
        logger.warning("user_fact dedupe lookup failed for %s: %s", user_id, e)
        existing_norms = set()

    final_rows = [
        r for r in cleaned if _normalize_for_dedupe(r["fact_text"]) not in existing_norms
    ]
    if not final_rows:
        return 0

    try:
        sb.table("user_fact").insert(final_rows).execute()
        return len(final_rows)
    except Exception as e:
        logger.warning("user_fact bulk insert failed for %s: %s", user_id, e)
        return 0
