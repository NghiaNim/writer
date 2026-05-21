"""One-time backfill: copy customized global settings into per-user rows.

Before migration 008, `data/settings.json` was the single source of truth
for stage prompts, temperatures, and search prefs. Multiple users all
shared that file — whoever PUT last won. After 008 those fields live in
the per-user `user_settings` table.

This script preserves the *pre-migration* behavior for existing users:
for every user already in the app, if a global value differs from the
factory default, we copy it into that user's row. NULL stays NULL for
anything that matches the factory default, so future changes to defaults
continue to flow through.

Idempotent: re-running it skips users who already have a row (we never
clobber a user's existing overrides).

Run with:

    uv run python -m backend.scripts.backfill_user_settings
    uv run python -m backend.scripts.backfill_user_settings --dry-run
"""
from __future__ import annotations

import argparse
import logging
import sys
from typing import Any, Dict, Set

from ..prompts import (
    STAGE1_PROMPT_DEFAULT,
    STAGE2_PROMPT_DEFAULT,
    STAGE3_PROMPT_DEFAULT,
)
from ..settings import get_settings
from ..supabase_client import get_supabase
from ..user_settings import PER_USER_FIELDS

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(message)s")


# Factory defaults for the per-user fields. Anything in `data/settings.json`
# that matches these is considered "uncustomized" and is NOT backfilled —
# we want NULL in user_settings so the user keeps tracking the operator
# defaults if those change later.
FACTORY_DEFAULTS: Dict[str, Any] = {
    "stage1_prompt": STAGE1_PROMPT_DEFAULT,
    "stage2_prompt": STAGE2_PROMPT_DEFAULT,
    "stage3_prompt": STAGE3_PROMPT_DEFAULT,
    "council_temperature": 0.95,
    "chairman_temperature": 0.85,
    "stage2_temperature": 0.3,
    "search_provider": "duckduckgo",
    "search_keyword_extraction": "direct",
    "search_result_count": 8,
    "search_hybrid_mode": True,
    "full_content_results": 3,
}


def _customized_overlay_from_global() -> Dict[str, Any]:
    """Read data/settings.json (via get_settings) and return only the
    fields that differ from the factory defaults — i.e. the things the
    operator actually customized in the old global-settings world."""
    settings = get_settings()
    overlay: Dict[str, Any] = {}
    for field in PER_USER_FIELDS:
        current = getattr(settings, field, None)
        # SearchProvider enum → string for Postgres
        if hasattr(current, "value"):
            current = current.value
        default = FACTORY_DEFAULTS.get(field)
        if current is None:
            continue
        if current == default:
            continue
        overlay[field] = current
    return overlay


# PostgREST defaults max-rows to 1000; we paginate explicitly so a single
# query never has to materialize a multi-million-row table in memory.
_PAGE_SIZE = 1000


def _paged_user_ids(sb, table: str) -> Set[str]:
    """Stream every `user_id` from one table, page by page."""
    out: Set[str] = set()
    offset = 0
    while True:
        try:
            res = (
                sb.table(table)
                .select("user_id")
                .range(offset, offset + _PAGE_SIZE - 1)
                .execute()
            )
        except Exception as e:
            logger.warning(
                "skip %s — query failed at offset %d: %s", table, offset, e
            )
            return out
        rows = res.data or []
        for row in rows:
            uid = row.get("user_id")
            if uid:
                out.add(uid)
        if len(rows) < _PAGE_SIZE:
            return out
        offset += _PAGE_SIZE


def _collect_user_ids(sb) -> Set[str]:
    """Enumerate every user_id that has ever used the app.

    Union of: voice_profiles + user_council_config + conversations +
    essay_memory + user_fact. Each table seeds at a different point in the
    user journey; the union catches every active user without depending on
    the Supabase admin auth API (which paginates and gets noisy at scale).
    """
    user_ids: Set[str] = set()
    sources = [
        "voice_profiles",
        "user_council_config",
        "conversations",
        "essay_memory",
        "user_fact",
        "essay_sessions",
    ]
    for table in sources:
        user_ids.update(_paged_user_ids(sb, table))
    return user_ids


def _existing_user_settings_ids(sb) -> Set[str]:
    """Users who already have a user_settings row — don't touch them."""
    return _paged_user_ids(sb, "user_settings")


def main(dry_run: bool = False) -> int:
    overlay = _customized_overlay_from_global()
    if not overlay:
        logger.info(
            "Nothing to backfill: data/settings.json matches factory defaults "
            "for every per-user field. New users will track defaults as "
            "intended."
        )
        return 0

    logger.info(
        "Operator has customized %d field(s): %s",
        len(overlay),
        sorted(overlay.keys()),
    )

    sb = get_supabase()
    candidate_ids = _collect_user_ids(sb)
    if not candidate_ids:
        logger.info("No existing users found in the database. Nothing to do.")
        return 0
    logger.info("Found %d distinct user(s) across user-owned tables.", len(candidate_ids))

    existing_ids = _existing_user_settings_ids(sb)
    if existing_ids:
        logger.info(
            "%d user(s) already have a user_settings row — leaving them untouched.",
            len(existing_ids),
        )

    targets = sorted(candidate_ids - existing_ids)
    if not targets:
        logger.info("All known users already have a user_settings row. Done.")
        return 0

    logger.info(
        "Would insert %d new user_settings row(s)%s.",
        len(targets),
        " (dry run — no writes)" if dry_run else "",
    )

    if dry_run:
        for uid in targets[:5]:
            logger.info("  sample: %s ← %s", uid, overlay)
        if len(targets) > 5:
            logger.info("  …and %d more", len(targets) - 5)
        return 0

    inserted = 0
    failed = 0
    for uid in targets:
        payload = {"user_id": uid, **overlay}
        try:
            sb.table("user_settings").insert(payload).execute()
            inserted += 1
        except Exception as e:
            # Most likely: race with a concurrent first PUT from the same
            # user (unique constraint on user_id). Treat as benign.
            failed += 1
            logger.warning("insert failed for user=%s: %s", uid, e)

    logger.info("Backfill complete: %d inserted, %d failed.", inserted, failed)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be inserted but don't write to the database.",
    )
    args = parser.parse_args()
    sys.exit(main(dry_run=args.dry_run))
