"""Per-user override storage for prompts / temperatures / search prefs / tunables.

A small set of fields used to live globally in `data/settings.json` even
though, in a hosted multi-user deployment, every user clobbered every
other user's values. Migration 008 moved them into a per-user
`user_settings` row. NULL columns mean "fall back to the operator-wide
default" (which still lives in `backend/settings.py`).

Migration 009 added a `tunables` JSONB column for per-user feature-flag
overrides. The set of valid keys is owned by `frontend/src/tunables.js`;
the backend treats it as opaque JSON and just stores / returns it.

API:
    PER_USER_FIELDS         — set of scalar override field names.
    load_user_settings      — read scalar overrides as a {field: value} dict.
    update_user_settings    — upsert one or more scalar fields.
    load_user_tunables      — read the tunables JSONB blob (dict or {}).
    update_user_tunables    — upsert the tunables blob (merge or replace).

This module deliberately stays small — the overlay itself is applied in
`backend/settings.py:get_settings()` via a request-scoped ContextVar set
in `backend/main.py:send_message_stream` (and friends).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)

# Whitelist of fields a user can override. Anything not in this set is
# operator-wide and stays in `data/settings.json` (or env vars, for the
# secrets covered by SECRET_FIELDS).
PER_USER_FIELDS: set[str] = {
    "stage1_prompt",
    "stage2_prompt",
    "stage3_prompt",
    "council_temperature",
    "chairman_temperature",
    "stage2_temperature",
    "search_provider",
    "search_keyword_extraction",
    "search_result_count",
    "search_hybrid_mode",
    "full_content_results",
}


def _row_to_overlay(row: Dict[str, Any]) -> Dict[str, Any]:
    """Strip NULLs + the bookkeeping columns; return only overridden fields."""
    overlay: Dict[str, Any] = {}
    for field in PER_USER_FIELDS:
        value = row.get(field)
        if value is not None:
            overlay[field] = value
    return overlay


def load_user_settings(user_id: str) -> Dict[str, Any]:
    """Return this user's per-field overrides.

    Empty dict if no row exists or the table isn't available — callers fall
    back to the operator-wide defaults. Never raises.
    """
    if not user_id:
        return {}
    sb = get_supabase()
    try:
        res = (
            sb.table("user_settings")
            .select("*")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.warning("user_settings fetch failed for user=%s: %s", user_id, e)
        return {}
    rows = res.data or []
    if not rows:
        return {}
    return _row_to_overlay(rows[0])


def update_user_settings(user_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
    """Upsert one or more per-user overrides.

    `updates` keys must be a subset of PER_USER_FIELDS. To clear an override
    (and fall back to the operator-wide default) pass the field with value
    None.

    Returns the fresh overlay dict (post-write).
    """
    if not user_id:
        return {}

    filtered: Dict[str, Any] = {}
    rejected: list[str] = []
    for key, value in (updates or {}).items():
        if key in PER_USER_FIELDS:
            filtered[key] = value
        else:
            rejected.append(key)
    if rejected:
        logger.warning(
            "update_user_settings: ignored non-overridable fields: %s", rejected
        )
    if not filtered:
        return load_user_settings(user_id)

    payload: Dict[str, Any] = {"user_id": user_id, **filtered}
    sb = get_supabase()
    try:
        sb.table("user_settings").upsert(payload, on_conflict="user_id").execute()
    except Exception as e:
        logger.warning("user_settings upsert failed for user=%s: %s", user_id, e)
        return load_user_settings(user_id)
    return load_user_settings(user_id)


def reset_user_setting(user_id: str, field: str) -> Dict[str, Any]:
    """Clear a single override so the user falls back to the global default."""
    if field not in PER_USER_FIELDS:
        return load_user_settings(user_id)
    return update_user_settings(user_id, {field: None})


# ---------------------------------------------------------------------------
# Tunables (feature flags) — opaque JSONB blob on user_settings.
# ---------------------------------------------------------------------------
#
# Registry of valid tunable keys lives in frontend/src/tunables.js. The
# backend never validates the key set — it just stores whatever the client
# sends so we can ship a new tunable without a backend deploy. Unknown keys
# the client receives are ignored by the frontend hook.


def load_user_tunables(user_id: str) -> Dict[str, Any]:
    """Return this user's tunable overrides as a flat dict. Empty if none."""
    if not user_id:
        return {}
    sb = get_supabase()
    try:
        res = (
            sb.table("user_settings")
            .select("tunables")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.warning("user_settings tunables fetch failed for user=%s: %s", user_id, e)
        return {}
    rows = res.data or []
    if not rows:
        return {}
    blob = rows[0].get("tunables") or {}
    return blob if isinstance(blob, dict) else {}


def update_user_tunables(
    user_id: str, patch: Dict[str, Any], *, replace: bool = False
) -> Dict[str, Any]:
    """Upsert the user's tunables blob.

    Args:
        patch: keys + values to set. Pass `None` as a value to clear that
            key (so it falls back to the registry default).
        replace: when True, overwrites the whole blob with `patch`. When
            False (default), merges `patch` onto the existing blob — this
            matches how the frontend toggles flags one at a time.
    """
    if not user_id:
        return {}

    if replace:
        new_blob = {k: v for k, v in (patch or {}).items() if v is not None}
    else:
        current = load_user_tunables(user_id)
        new_blob = dict(current)
        for k, v in (patch or {}).items():
            if v is None:
                new_blob.pop(k, None)
            else:
                new_blob[k] = v

    payload = {"user_id": user_id, "tunables": new_blob}
    sb = get_supabase()
    try:
        sb.table("user_settings").upsert(payload, on_conflict="user_id").execute()
    except Exception as e:
        logger.warning("user_settings tunables upsert failed for user=%s: %s", user_id, e)
        return load_user_tunables(user_id)
    return new_blob
