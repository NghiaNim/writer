"""Invisible voice scaffolding from `public.voice_library`.

The council picks one library voice per essay run (random, optionally seeded
by session_id so re-runs of the same session use the same anchor). The
chosen row is rendered into a prompt block that is injected into:

  * Each Stage 1 persona prompt (especially Voice Guardian)
  * The Stage 3 Chairman synthesis prompt

Users never see this content directly; it's purely a creative scaffold for
the LLMs. The chosen `voice_library_id` is recorded on the `essay_sessions`
row so an admin audit can trace voice choices.
"""

from __future__ import annotations

import hashlib
import logging
import random
from typing import Any, Dict, Optional

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)


# Cap how much of `essay_text` we feed into the prompt. Whole essays would
# blow context budget on weaker models. ~600 words is a generous excerpt
# that captures voice without dominating the prompt.
ESSAY_EXCERPT_CHAR_BUDGET = 3500


def _seeded_random(seed: Optional[str]) -> random.Random:
    """Return a Random seeded by `seed` (or unseeded if None)."""
    if not seed:
        return random.Random()
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def pick_random_voice(
    seed: Optional[str] = None,
    exclude_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Pick one row from voice_library at random.

    Args:
        seed: stable string (e.g. session_id). Same seed → same voice across
              re-runs of the same essay.
        exclude_id: optional id to skip (used when explicitly re-rolling).

    Returns the row dict or None if the library is empty.
    """
    sb = get_supabase()
    try:
        res = sb.table("voice_library").select("*").execute()
    except Exception as e:
        logger.warning("voice_library fetch failed: %s", e)
        return None

    rows = res.data or []
    if exclude_id:
        rows = [r for r in rows if r.get("id") != exclude_id]
    if not rows:
        return None

    rng = _seeded_random(seed)
    return rng.choice(rows)


def get_voice_by_id(voice_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a specific library row by id, or None if missing."""
    sb = get_supabase()
    try:
        res = (
            sb.table("voice_library")
            .select("*")
            .eq("id", voice_id)
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.warning("voice_library fetch by id failed: %s", e)
        return None
    rows = res.data or []
    return rows[0] if rows else None


def _truncate_excerpt(text: str, budget: int = ESSAY_EXCERPT_CHAR_BUDGET) -> str:
    """Trim `text` to roughly `budget` chars, breaking on a sentence boundary."""
    if not text or len(text) <= budget:
        return (text or "").strip()
    cut = text[:budget]
    # Walk back to last sentence-ending punctuation so the excerpt reads cleanly.
    for stop in (". ", "! ", "? ", "\n"):
        idx = cut.rfind(stop)
        if idx > budget * 0.6:
            return cut[: idx + 1].strip() + " […]"
    return cut.strip() + " […]"


def format_library_voice_block(voice: Optional[Dict[str, Any]]) -> str:
    """Render a library voice as a prompt-friendly creative scaffold.

    The block is intentionally framed as inspiration, not instruction:
    we don't want models to mimic the topic or content, only the rhythm,
    cadence, and stylistic moves. Returns empty string if no voice.
    """
    if not voice:
        return ""

    sections = [
        "VOICE INSPIRATION (DO NOT IMITATE TOPIC OR CONTENT — ONLY THE RHYTHM, CADENCE, AND MOVES):",
        "Below is a writing sample we'd like to anchor your prose against. Match the tone, sentence rhythm, and use of specific concrete detail. DO NOT borrow the subject matter, places, or anecdotes — those belong to a different writer. Use this purely as a stylistic tuning fork.",
    ]

    sentence_style = (voice.get("sentence_style") or "").strip()
    if sentence_style:
        sections.append("")
        sections.append(f"Sentence style to echo: {sentence_style}")

    tone = (voice.get("tone") or "").strip()
    if tone:
        sections.append(f"Tone to echo: {tone}")

    moves = voice.get("distinctive_moves") or []
    if isinstance(moves, list) and moves:
        sections.append("")
        sections.append("Distinctive moves to draw from sparingly:")
        for m in moves:
            if isinstance(m, str) and m.strip():
                sections.append(f"- {m.strip()}")

    avoid = voice.get("avoid_in_imitation") or []
    if isinstance(avoid, list) and avoid:
        sections.append("")
        sections.append("Avoid in your output:")
        for a in avoid:
            if isinstance(a, str) and a.strip():
                sections.append(f"- {a.strip()}")

    excerpt = _truncate_excerpt(voice.get("essay_text") or "")
    if excerpt:
        sections.append("")
        sections.append("Writing sample (style anchor):")
        sections.append("\"\"\"")
        sections.append(excerpt)
        sections.append("\"\"\"")

    sample = (voice.get("sample_sentence") or "").strip()
    if sample:
        sections.append("")
        sections.append(f"One representative sentence in this voice: {sample}")

    sections.append("")
    return "\n".join(sections)
