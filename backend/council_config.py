"""Per-user default council configuration.

Endpoints (all require `Authorization: Bearer <jwt>`):

    GET  /council-config           Returns the caller's default council, or a
                                   factory default seeded from the 4 essay
                                   personas if the user has none yet.
    PUT  /council-config           Save the caller's default council.

The shape returned to the client and stored in `user_council_config`:

    {
      "personas": [
        {"key": "architect",       "enabled": true,  "model": "openrouter:..."},
        {"key": "editor",          "enabled": true,  "model": "openrouter:..."},
        {"key": "devils_advocate", "enabled": true,  "model": "openrouter:..."},
        {"key": "voice_guardian",  "enabled": true,  "model": "openrouter:..."}
      ],
      "chairman_model": "openrouter:..."
    }

The same shape is also written into `essay_sessions.council_config` for
per-essay overrides (see backend/sessions.py).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from .auth import AuthUser, get_current_user
from .prompts import DEFAULT_COUNCIL_PERSONAS, PERSONA_KEYS
from .supabase_client import get_supabase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/council-config", tags=["council-config"])


# ---------------------------------------------------------------------------
# Default chairman + per-persona models (used when seeding a new user).
# Curated to balance quality and cost on OpenRouter, the only call path the
# spec lets us use.
# ---------------------------------------------------------------------------

# Verified against the live OpenRouter catalog. Older IDs like
# Defaults span four different model families so the council isn't an echo
# chamber, and the Chairman is deliberately picked from a *fifth* family slot
# (Gemini Pro) so it isn't the same family as the Architect — otherwise the
# same model would write one of the four drafts AND synthesize the winner,
# biasing Stage 3 toward whatever Stage 1 voice it already produced.
#
# OpenRouter slugs shift over time. If any of these 404 in the catalog
# (https://openrouter.ai/api/v1/models), update the right-hand sides; nothing
# else in the codebase depends on the exact strings.
DEFAULT_PERSONA_MODELS = {
    "architect": "openrouter:anthropic/claude-sonnet-4.6",
    "editor": "openrouter:openai/gpt-4.1",
    "devils_advocate": "openrouter:google/gemini-2.5-flash",
    "voice_guardian": "openrouter:meta-llama/llama-3.3-70b-instruct",
}
# Chairman intentionally NOT in the Anthropic family (Architect is Claude).
DEFAULT_CHAIRMAN_MODEL = "openrouter:google/gemini-2.5-pro"


def factory_council_config() -> Dict[str, Any]:
    return {
        "personas": [
            {
                "key": p["key"],
                "enabled": True,
                "model": DEFAULT_PERSONA_MODELS.get(p["key"], ""),
            }
            for p in DEFAULT_COUNCIL_PERSONAS
        ],
        "chairman_model": DEFAULT_CHAIRMAN_MODEL,
    }


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class PersonaConfig(BaseModel):
    key: str
    enabled: bool = True
    # Empty string allowed when persona is disabled. We validate that any
    # *enabled* persona has a model server-side (see save_council_config).
    model: str = ""

    @field_validator("key")
    @classmethod
    def _key_must_be_known(cls, v: str) -> str:
        if v not in PERSONA_KEYS:
            raise ValueError(
                f"Unknown persona key '{v}'. Allowed: {sorted(PERSONA_KEYS)}"
            )
        return v


class CouncilConfigBody(BaseModel):
    personas: List[PersonaConfig] = Field(default_factory=list)
    chairman_model: Optional[str] = None


class CouncilConfigResponse(BaseModel):
    personas: List[PersonaConfig]
    chairman_model: Optional[str]
    enabled_count: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_response(payload: Dict[str, Any]) -> CouncilConfigResponse:
    personas = [PersonaConfig(**p) for p in (payload.get("personas") or [])]
    return CouncilConfigResponse(
        personas=personas,
        chairman_model=payload.get("chairman_model"),
        enabled_count=sum(1 for p in personas if p.enabled),
    )


def _normalize(body: CouncilConfigBody) -> Dict[str, Any]:
    """Reorder personas to canonical PERSONA_KEYS order, drop unknowns,
    fill any missing personas with disabled stubs.

    This guarantees we always store all 4 personas even if the client only
    sent overrides for some, which keeps the per-essay override merge logic
    simple downstream.
    """
    by_key: Dict[str, PersonaConfig] = {p.key: p for p in body.personas}
    canonical: List[Dict[str, Any]] = []
    for k in PERSONA_KEYS:
        p = by_key.get(k)
        if p is None:
            canonical.append({"key": k, "enabled": False, "model": ""})
        else:
            canonical.append({
                "key": k,
                "enabled": bool(p.enabled),
                "model": (p.model or "").strip(),
            })

    enabled_count = sum(1 for p in canonical if p["enabled"])
    if enabled_count < 2:
        raise HTTPException(
            status_code=400,
            detail="Council needs at least 2 enabled personas.",
        )

    # Every *enabled* persona must have a model. Disabled personas may store
    # an empty model (we keep the row so flipping it back on is one click).
    for p in canonical:
        if p["enabled"] and not p["model"]:
            raise HTTPException(
                status_code=400,
                detail=f"Enabled persona '{p['key']}' is missing a model.",
            )

    chairman = (body.chairman_model or "").strip() or None
    if chairman is None:
        raise HTTPException(
            status_code=400,
            detail="chairman_model is required.",
        )

    return {"personas": canonical, "chairman_model": chairman}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=CouncilConfigResponse)
async def get_council_config(user: AuthUser = Depends(get_current_user)):
    """Return the caller's default council, or a factory default if unset."""
    supabase = get_supabase()
    try:
        result = (
            supabase.table("user_council_config")
            .select("personas, chairman_model")
            .eq("user_id", user.id)
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.warning(f"Failed to load council config for {user.id}: {e}")
        return _to_response(factory_council_config())

    if not result.data:
        return _to_response(factory_council_config())

    row = result.data[0]
    return _to_response(
        {
            "personas": row.get("personas") or factory_council_config()["personas"],
            "chairman_model": row.get("chairman_model"),
        }
    )


@router.put("", response_model=CouncilConfigResponse)
async def save_council_config(
    body: CouncilConfigBody,
    user: AuthUser = Depends(get_current_user),
):
    """Save the caller's default council. Upserts a single row."""
    payload = _normalize(body)
    supabase = get_supabase()
    try:
        # Upsert by primary key (user_id). user_council_config has one row per user.
        result = (
            supabase.table("user_council_config")
            .upsert(
                {
                    "user_id": user.id,
                    "personas": payload["personas"],
                    "chairman_model": payload["chairman_model"],
                },
                on_conflict="user_id",
            )
            .execute()
        )
    except Exception as e:
        logger.warning(f"Failed to save council config for {user.id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to save council config")
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save council config")
    return _to_response(payload)
