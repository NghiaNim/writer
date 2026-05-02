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
# blow context budget on weaker models. ~850 words is a generous excerpt
# that captures voice strongly without dominating the prompt — the actual
# writing is the highest-signal voice anchor we have, so we lean toward
# more text rather than less.
ESSAY_EXCERPT_CHAR_BUDGET = 5000


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

    The actual writing sample leads the block — it's the highest-signal voice
    anchor we have, and models weight earlier tokens more. The AI-derived
    metadata (tone, sentence style, distinctive moves) follows as supporting
    commentary, not as the primary instruction.

    Framed as inspiration, not instruction: we want models to absorb rhythm,
    cadence, and concrete-detail density — never the topic or content.
    Returns empty string if no voice is provided.
    """
    if not voice:
        return ""

    sections = [
        "VOICE INSPIRATION — STUDY THE WRITING BELOW (DO NOT IMITATE TOPIC OR CONTENT, ONLY RHYTHM AND MOVES):",
        "The passage below is a stylistic tuning fork. Read it before you write. Match its sentence rhythm, its willingness to use specific concrete detail, and its tonal commitments. DO NOT borrow its subject matter, places, anecdotes, or claims — those belong to a different writer.",
    ]

    excerpt = _truncate_excerpt(voice.get("essay_text") or "")
    if excerpt:
        sections.append("")
        sections.append("WRITING SAMPLE (the voice you are echoing):")
        sections.append("\"\"\"")
        sections.append(excerpt)
        sections.append("\"\"\"")

    sample = (voice.get("sample_sentence") or "").strip()
    if sample:
        sections.append("")
        sections.append(f"One representative sentence from this voice: {sample}")

    # Supporting hints derived from analysis of the sample above. These are
    # secondary — the writing itself is the source of truth.
    hints: list[str] = []
    sentence_style = (voice.get("sentence_style") or "").strip()
    if sentence_style:
        hints.append(f"Sentence style: {sentence_style}")

    tone = (voice.get("tone") or "").strip()
    if tone:
        hints.append(f"Tone: {tone}")

    moves = voice.get("distinctive_moves") or []
    move_lines: list[str] = []
    if isinstance(moves, list) and moves:
        for m in moves:
            if isinstance(m, str) and m.strip():
                move_lines.append(f"- {m.strip()}")

    avoid = voice.get("avoid_in_imitation") or []
    avoid_lines: list[str] = []
    if isinstance(avoid, list) and avoid:
        for a in avoid:
            if isinstance(a, str) and a.strip():
                avoid_lines.append(f"- {a.strip()}")

    if hints or move_lines or avoid_lines:
        sections.append("")
        sections.append("Notes on this voice (use as cross-reference; the sample above is the source of truth):")
        for h in hints:
            sections.append(h)
        if move_lines:
            sections.append("Distinctive moves to draw from sparingly:")
            sections.extend(move_lines)
        if avoid_lines:
            sections.append("Avoid in your output:")
            sections.extend(avoid_lines)

    sections.append("")
    return "\n".join(sections)
