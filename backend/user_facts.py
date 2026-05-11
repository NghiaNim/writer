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

VALID_SOURCES = ("manual", "intake", "chat", "feedback", "essay", "summary")

# When the active-fact corpus crosses this many characters, the oldest half
# is folded into a single synthetic 'summary' fact so the prompt block stays
# bounded. Originals are kept (archived) so the user never loses raw input.
PROFILE_BLOCK_BUDGET_CHARS = 8000

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
    """Active facts only (archived rows are excluded). Used to build the
    student-profile block injected into council prompts."""
    sb = get_supabase()
    try:
        res = (
            sb.table("user_fact")
            .select("id, fact_text, category, source, source_essay_id, created_at")
            .eq("user_id", user_id)
            .is_("archived_at", "null")
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


def list_user_facts(
    user_id: str, limit: int = 100, include_archived: bool = False
) -> List[Dict[str, Any]]:
    sb = get_supabase()
    try:
        q = (
            sb.table("user_fact")
            .select(
                "id, fact_text, category, source, source_essay_id, "
                "archived_at, superseded_by, created_at"
            )
            .eq("user_id", user_id)
        )
        if not include_archived:
            q = q.is_("archived_at", "null")
        res = q.order("created_at", desc=True).limit(limit).execute()
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
            .is_("archived_at", "null")
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


# ---------------------------------------------------------------------------
# Summarization-on-overflow
# ---------------------------------------------------------------------------
#
# When a user has so many active facts that injecting them all would blow the
# prompt budget, we fold the oldest half into ONE synthetic 'summary' fact and
# archive the originals (archived_at + superseded_by). The originals are kept
# in the table so /api/user-facts can still surface them in the "what we know
# about you" panel — they just stop participating in prompt construction.


def _active_facts_for_overflow(
    user_id: str, max_rows: int = 500
) -> List[Dict[str, Any]]:
    """Pull every active fact (oldest first) up to a safety cap."""
    sb = get_supabase()
    try:
        res = (
            sb.table("user_fact")
            .select("id, fact_text, category, created_at")
            .eq("user_id", user_id)
            .is_("archived_at", "null")
            .order("created_at", desc=False)
            .limit(max_rows)
            .execute()
        )
        return list(res.data or [])
    except Exception as e:
        logger.warning("active-fact scan failed for %s: %s", user_id, e)
        return []


def _archive_facts(user_id: str, fact_ids: List[str], summary_id: str) -> int:
    """Mark the given facts as archived and pointing at the summary row."""
    if not fact_ids or not summary_id:
        return 0
    sb = get_supabase()
    from datetime import datetime, timezone

    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        res = (
            sb.table("user_fact")
            .update({"archived_at": now_iso, "superseded_by": summary_id})
            .in_("id", fact_ids)
            .eq("user_id", user_id)
            .execute()
        )
        return len(res.data or [])
    except Exception as e:
        logger.warning("user_fact archive failed for %s: %s", user_id, e)
        return 0


async def maybe_summarize_overflow(user_id: str) -> int:
    """Compress oldest half of active facts into one summary fact when the
    corpus is too large to fit in a prompt cleanly. Returns count archived.

    Triggered after fact insertion (extract_and_store / interim Q&A). Safe to
    call frequently — it's a no-op until the budget is exceeded.
    """
    if not user_id:
        return 0
    facts = _active_facts_for_overflow(user_id)
    if not facts:
        return 0
    total_chars = sum(len((f.get("fact_text") or "")) for f in facts)
    if total_chars <= PROFILE_BLOCK_BUDGET_CHARS:
        return 0

    # Fold the oldest half. With ~24 facts at ~200 chars each, 12 oldest
    # become one summary; the next overflow trigger compresses again.
    half = max(1, len(facts) // 2)
    to_compress = facts[:half]
    if len(to_compress) < 4:
        # Not worth a round-trip if there's almost nothing to summarize.
        return 0

    block = "\n".join(
        f"- [{(f.get('category') or 'general')}] {(f.get('fact_text') or '').strip()}"
        for f in to_compress
        if (f.get("fact_text") or "").strip()
    )

    sys_prompt = (
        "You compress a list of durable facts about an essay writer into a "
        "single dense paragraph that another LLM can use as long-term memory. "
        "Preserve every concrete detail (places, names, fields, beliefs, "
        "experiences) — this paragraph replaces the originals in future "
        "prompt context. Third person, no 'I'. No bullet points. Under 220 "
        "words. Output the paragraph only, no preamble."
    )
    # Lazy import to avoid cycles (council imports user_facts).
    from .council import query_model

    try:
        res = await query_model(
            "google:gemini-2.5-flash",
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": block},
            ],
            timeout=45.0,
            temperature=0.2,
        )
    except Exception as e:
        logger.warning("overflow summarize call failed: %s", e)
        return 0
    if not res or res.get("error"):
        return 0
    summary_text = (res.get("content") or "").strip()
    if not summary_text:
        return 0
    if len(summary_text) > 6000:
        summary_text = summary_text[:6000].rstrip()

    # Insert the summary FIRST, then archive originals pointing at it. If the
    # archive step fails the originals remain active — degrades to "we have a
    # duplicate summary" which is fine.
    summary_row = add_user_fact(
        user_id=user_id,
        fact_text=summary_text,
        source="summary",
        category="general",
    )
    if not summary_row:
        return 0

    archived = _archive_facts(
        user_id, [str(f["id"]) for f in to_compress], str(summary_row["id"])
    )
    logger.info(
        "user_fact: summarized %d oldest into summary=%s for user=%s",
        archived,
        summary_row["id"],
        user_id,
    )
    return archived
