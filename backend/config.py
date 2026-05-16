"""Configuration for the LLM Council."""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load env from backend/.env explicitly so the app picks up secrets when
# launched from the project root (the documented launch path).
load_dotenv(Path(__file__).resolve().parent / ".env")

# OpenRouter API endpoint
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Data directory for conversation storage
DATA_DIR = "data/conversations"


def get_openrouter_api_key() -> str:
    """Get OpenRouter API key from settings or environment."""
    from .settings import get_settings
    settings = get_settings()
    if settings.openrouter_api_key:
        return settings.openrouter_api_key
    return os.getenv("OPENROUTER_API_KEY", "")


def get_ollama_base_url() -> str:
    """Get Ollama base URL from settings."""
    from .settings import get_settings
    return get_settings().ollama_base_url


def get_council_models() -> list:
    """Get council models from settings."""
    from .settings import get_settings, DEFAULT_COUNCIL_MODELS
    settings = get_settings()
    return settings.council_models or DEFAULT_COUNCIL_MODELS


def get_chairman_model() -> str:
    """Get chairman model from settings."""
    from .settings import get_settings, DEFAULT_CHAIRMAN_MODEL
    settings = get_settings()
    return settings.chairman_model or DEFAULT_CHAIRMAN_MODEL


# Legacy constants for backwards compatibility. Mirror DEFAULT_PERSONA_MODELS
# / DEFAULT_CHAIRMAN_MODEL in backend/council_config.py — see the note there
# about why the chairman must not be a reasoning-by-default model.
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
COUNCIL_MODELS = [
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.1",
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
]
CHAIRMAN_MODEL = "x-ai/grok-4.20"
