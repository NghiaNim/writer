"""Settings storage and management."""

import json
import os
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Optional, List, Dict
from pydantic import BaseModel
from .search import SearchProvider

# Settings file path
SETTINGS_FILE = Path(__file__).parent.parent / "data" / "settings.json"

# Operator-only secret fields: env vars are authoritative. The PUT
# /api/settings endpoint silently drops these fields, and get_settings()
# overlays env-var values on top of anything that might still be in
# data/settings.json (legacy installs).
SECRET_FIELDS: Dict[str, str] = {
    "openrouter_api_key": "OPENROUTER_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "google_api_key": "GOOGLE_API_KEY",
    "mistral_api_key": "MISTRAL_API_KEY",
    "deepseek_api_key": "DEEPSEEK_API_KEY",
    "groq_api_key": "GROQ_API_KEY",
    "tavily_api_key": "TAVILY_API_KEY",
    "brave_api_key": "BRAVE_API_KEY",
    "serper_api_key": "SERPER_API_KEY",
    "sapling_api_key": "SAPLING_API_KEY",
    "custom_endpoint_api_key": "CUSTOM_ENDPOINT_API_KEY",
}

# Request-scoped overlay of per-user settings (populated by the FastAPI
# endpoints via `apply_user_settings_overlay`). When set, `get_settings()`
# merges these on top of the operator-wide defaults so the rest of the
# codebase can keep calling get_settings() without threading user_id
# through every helper. Empty dict = no overlay = operator defaults only.
_user_settings_overlay: ContextVar[Dict[str, Any]] = ContextVar(
    "user_settings_overlay", default={}
)


def apply_user_settings_overlay(overlay: Optional[Dict[str, Any]]):
    """Set a per-user overlay for the current async context. Returns a
    token to pass to `clear_user_settings_overlay`. Safe to call with
    None/empty — overlay just becomes a no-op."""
    return _user_settings_overlay.set(overlay or {})


def clear_user_settings_overlay(token) -> None:
    """Restore the overlay to whatever it was before the matching
    `apply_user_settings_overlay` call. Always call this in a `finally`
    block so a failed request can't leak state into the next one."""
    try:
        _user_settings_overlay.reset(token)
    except (LookupError, ValueError):
        # Token from a different context — best-effort cleanup.
        _user_settings_overlay.set({})

# Default models. Four empty slots so the default council size matches the
# four essay personas (Architect, Editor, Devil's Advocate, Voice Guardian).
# Users still pick which actual models to assign.
DEFAULT_COUNCIL_MODELS = ["", "", "", ""]
DEFAULT_CHAIRMAN_MODEL = ""

# Default enabled providers
DEFAULT_ENABLED_PROVIDERS = {
    "openrouter": True,
    "ollama": False,
    "groq": False,
    "direct": False,  # Master toggle for all direct connections
    "custom": False   # Custom OpenAI-compatible endpoint
}

# Default direct provider toggles (individual)
DEFAULT_DIRECT_PROVIDER_TOGGLES = {
    "openai": False,
    "anthropic": False,
    "google": False,
    "mistral": False,
    "deepseek": False,
    "groq": False
}


from .prompts import (
    STAGE1_PROMPT_DEFAULT,
    STAGE2_PROMPT_DEFAULT,
    STAGE3_PROMPT_DEFAULT,
    DEFAULT_COUNCIL_PERSONAS,
)


class CouncilPersona(BaseModel):
    """A single Stage 1 persona assigned to a council member by index.

    `key` is a stable identifier (e.g. "architect", "editor") used by the
    per-user / per-essay council_config to refer to a persona independent of
    its position in this list. Older settings.json files won't have it, so
    it stays optional.

    `temperature` is an optional per-persona override. If None, the council
    falls back to `Settings.council_temperature`. The Voice Guardian uses a
    cooler default so it doesn't invent voice rules when riffing on the
    user's profile.
    """
    key: Optional[str] = None
    name: str
    description: str = ""
    prompt: str
    temperature: Optional[float] = None


def _default_personas() -> List["CouncilPersona"]:
    return [CouncilPersona(**p) for p in DEFAULT_COUNCIL_PERSONAS]


class Settings(BaseModel):
    """Application settings."""
    search_provider: SearchProvider = SearchProvider.DUCKDUCKGO
    search_keyword_extraction: str = "direct"  # "direct" or "yake"
    search_result_count: int = 8  # Number of search results (5-15, default 8)
    search_hybrid_mode: bool = True  # Combine web+news search for DuckDuckGo

    # API Keys
    tavily_api_key: Optional[str] = None
    brave_api_key: Optional[str] = None
    serper_api_key: Optional[str] = None
    sapling_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    google_api_key: Optional[str] = None
    mistral_api_key: Optional[str] = None
    deepseek_api_key: Optional[str] = None
    groq_api_key: Optional[str] = None

    # Ollama Settings
    ollama_base_url: str = "http://localhost:11434"

    # Custom OpenAI-compatible endpoint
    custom_endpoint_name: Optional[str] = None
    custom_endpoint_url: Optional[str] = None
    custom_endpoint_api_key: Optional[str] = None

    # Enabled Providers (which sources are available for council selection)
    enabled_providers: Dict[str, bool] = DEFAULT_ENABLED_PROVIDERS.copy()

    # Individual direct provider toggles
    direct_provider_toggles: Dict[str, bool] = DEFAULT_DIRECT_PROVIDER_TOGGLES.copy()

    # Council Configuration (unified across all providers)
    council_models: List[str] = DEFAULT_COUNCIL_MODELS.copy()
    chairman_model: str = DEFAULT_CHAIRMAN_MODEL
    
    # Temperature Settings — tuned hot for personal-essay creativity.
    # Stage 1 personas draft at 0.95 (very risk-taking); Voice Guardian
    # overrides to 0.65 via its persona.temperature so it doesn't
    # hallucinate voice rules. Stage 2 stays low so peer ranking parses
    # reliably. Stage 3 (Chairman) at 0.85 leaves room for bold synthesis.
    council_temperature: float = 0.95
    chairman_temperature: float = 0.85
    stage2_temperature: float = 0.3  # Lower for consistent ranking output
    
    # Remote/Local filters
    council_member_filters: Optional[Dict[int, str]] = None
    chairman_filter: Optional[str] = None
    search_query_filter: Optional[str] = None

    full_content_results: int = 3  # Number of search results to fetch full content for (0 to disable)
    show_free_only: bool = False  # Filter to show only free OpenRouter models

    # System Prompts
    stage1_prompt: str = STAGE1_PROMPT_DEFAULT
    stage2_prompt: str = STAGE2_PROMPT_DEFAULT
    stage3_prompt: str = STAGE3_PROMPT_DEFAULT

    # Stage 1 council personas. Council member at index i uses
    # council_personas[i].prompt as their Stage 1 system prompt. Members
    # whose index exceeds the persona list fall back to stage1_prompt.
    council_personas: List[CouncilPersona] = []  # populated via get_settings() if empty


def get_settings() -> Settings:
    """Load settings from file, or return defaults.

    Env vars take precedence over stored values for every field in
    SECRET_FIELDS — secrets are operator-only and not user-mutable.
    """
    settings: Settings
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r") as f:
                data = json.load(f)
                settings = Settings(**data)
        except Exception:
            settings = Settings()
    else:
        settings = Settings()

    # Overlay env-var secrets on top of anything that might have been
    # persisted in settings.json (legacy installs, mistakenly-written
    # values). After this overlay, reads of settings.openai_api_key etc.
    # always reflect what the operator set in the environment.
    for field, env_name in SECRET_FIELDS.items():
        env_value = os.getenv(env_name)
        if env_value:
            setattr(settings, field, env_value)

    # Overlay per-user prefs (prompts, temperatures, search prefs) from
    # the request-scoped ContextVar populated by the FastAPI endpoint.
    # If no overlay is set (background tasks, scripts), we just return
    # the operator-wide defaults.
    user_overlay = _user_settings_overlay.get()
    if user_overlay:
        # SearchProvider needs special-casing — it's a Pydantic enum field
        # but the overlay carries a plain string from Postgres.
        for field, value in user_overlay.items():
            if value is None:
                continue
            if field == "search_provider":
                try:
                    setattr(settings, field, SearchProvider(value))
                except ValueError:
                    continue
            elif hasattr(settings, field):
                setattr(settings, field, value)

    # If personas are missing (fresh install or older settings.json),
    # seed with the 4 essay-writing defaults. We do not overwrite a
    # user-customized non-empty list.
    if not settings.council_personas:
        settings.council_personas = _default_personas()
    else:
        # Older settings.json may have personas without a `key`. Backfill
        # by matching name; falls back to position in DEFAULT_COUNCIL_PERSONAS
        # if the name doesn't match.
        defaults_by_name = {p["name"]: p["key"] for p in DEFAULT_COUNCIL_PERSONAS}
        for i, persona in enumerate(settings.council_personas):
            if not persona.key:
                inferred = defaults_by_name.get(persona.name)
                if not inferred and i < len(DEFAULT_COUNCIL_PERSONAS):
                    inferred = DEFAULT_COUNCIL_PERSONAS[i]["key"]
                persona.key = inferred

    return settings


def save_settings(settings: Settings) -> None:
    """Save settings to file."""
    # Ensure data directory exists
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)

    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings.model_dump(), f, indent=2)


def update_settings(**kwargs) -> Settings:
    """Update specific settings and save."""
    current = get_settings()
    updated_data = current.model_dump()
    updated_data.update(kwargs)
    updated = Settings(**updated_data)
    save_settings(updated)
    return updated
