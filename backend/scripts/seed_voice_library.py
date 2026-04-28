"""Seed `public.voice_library` from the JSON files in `voices/`.

Idempotent on `source_file`: re-running updates existing rows in place.
Run with:

    uv run python -m backend.scripts.seed_voice_library

The library powers invisible voice scaffolding for the council (see
`backend/voice_library.py`). Users never see these rows directly.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

from ..supabase_client import get_supabase

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(message)s")


VOICES_DIR = Path(__file__).resolve().parent.parent.parent / "voices"


# Map JSON keys → DB column names. Identical for now but explicit so future
# rename refactors stay obvious.
SCALAR_FIELDS = {
    "prompt": "prompt",
    "essay_text": "essay_text",
    "persona_prompt": "persona_prompt",
    "tone": "tone",
    "sentence_style": "sentence_style",
    "vocabulary_level": "vocabulary_level",
    "structural_patterns": "structural_patterns",
    "self_presentation": "self_presentation",
    "cultural_or_contextual_markers": "cultural_or_contextual_markers",
    "sample_sentence": "sample_sentence",
}

JSON_LIST_FIELDS = {
    "distinctive_moves": "distinctive_moves",
    "themes_and_preoccupations": "themes_and_preoccupations",
    "avoid_in_imitation": "avoid_in_imitation",
}


def _row_from_file(path: Path) -> dict | None:
    """Build a voice_library row from a single JSON file. Returns None on errors."""
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.warning("skip %s — invalid JSON: %s", path.name, e)
        return None

    essay_text = (data.get("essay_text") or "").strip()
    if not essay_text:
        logger.warning("skip %s — empty essay_text", path.name)
        return None

    row: dict[str, object] = {
        "source_file": path.name,
        "essay_text": essay_text,
    }
    for json_key, col in SCALAR_FIELDS.items():
        if json_key == "essay_text":
            continue  # already handled
        val = data.get(json_key)
        if isinstance(val, str):
            row[col] = val.strip()
    for json_key, col in JSON_LIST_FIELDS.items():
        val = data.get(json_key)
        if isinstance(val, list):
            # Coerce all entries to strings; drop empty
            row[col] = [str(x).strip() for x in val if x and str(x).strip()]
        else:
            row[col] = []
    return row


def main() -> int:
    if not VOICES_DIR.exists():
        logger.error("voices directory not found: %s", VOICES_DIR)
        return 2

    files = sorted(VOICES_DIR.glob("*.json"))
    if not files:
        logger.error("no JSON files found in %s", VOICES_DIR)
        return 2

    sb = get_supabase()
    inserted = 0
    updated = 0
    skipped = 0

    for path in files:
        row = _row_from_file(path)
        if row is None:
            skipped += 1
            continue
        # Try update first; if no row exists, insert. Cheaper than fetching
        # then deciding, and avoids a race with concurrent seeds.
        existing = (
            sb.table("voice_library")
            .select("id")
            .eq("source_file", row["source_file"])
            .limit(1)
            .execute()
        )
        if existing.data:
            sb.table("voice_library").update(row).eq(
                "source_file", row["source_file"]
            ).execute()
            updated += 1
        else:
            sb.table("voice_library").insert(row).execute()
            inserted += 1

    logger.info(
        "voice_library seeded: %d inserted, %d updated, %d skipped (out of %d files)",
        inserted,
        updated,
        skipped,
        len(files),
    )
    total = sb.table("voice_library").select("id", count="exact").execute()
    logger.info("voice_library total rows: %s", total.count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
