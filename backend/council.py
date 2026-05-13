"""3-stage LLM Council orchestration."""

from typing import List, Dict, Any, Optional, Tuple
import asyncio
import logging
from . import openrouter
from . import ollama_client
from .config import get_council_models, get_chairman_model
from .search import perform_web_search, SearchProvider
from .settings import CouncilPersona, get_settings
from .voice_profile import format_voice_profile_block, load_voice_profile, VoiceProfile
from .voice_library import format_library_voice_block
from .user_facts import load_recent_user_facts, format_student_profile_block
from .prompts import (
    DEFAULT_COUNCIL_PERSONAS,
    PERSONAS_BY_KEY,
    format_essay_mode_block,
    format_word_target_block,
)


# ---------------------------------------------------------------------------
# Per-call council resolution (extension #1 — user-customized council)
# ---------------------------------------------------------------------------


def resolve_council_config(council_config: Optional[Dict[str, Any]]) -> Tuple[
    List[CouncilPersona], List[str], Optional[str]
]:
    """Turn a council_config dict into (personas, models, chairman_model).

    Shape of `council_config`:
        {
          "personas": [
            {"key": "architect", "enabled": true, "model": "openrouter:..."},
            ...
          ],
          "chairman_model": "openrouter:..."
        }

    - Disabled personas are dropped.
    - Personas without a model fall back to factory defaults (settings).
    - Unknown persona keys are skipped.
    - If `council_config` is None or has no enabled personas, falls back to
      `settings.council_personas` + `settings.council_models`.
    - Council size is clamped to >= 2 enabled personas; if the user disables
      all but one, we silently re-enable the rest in default order. (We
      validate >=2 in the API layer too.)

    Returns:
        personas: List of CouncilPersona objects (in execution order)
        models:   List of model IDs (same length, same order)
        chairman_model: explicit override, or None to use settings default
    """
    settings = get_settings()
    factory_personas = settings.council_personas or [
        CouncilPersona(**p) for p in DEFAULT_COUNCIL_PERSONAS
    ]
    factory_models = settings.council_models or []
    factory_by_key = {p.key: p for p in factory_personas if p.key}

    # No override / unusable override -> factory defaults
    if not council_config or not isinstance(council_config, dict):
        return factory_personas, factory_models, None

    raw_entries = council_config.get("personas") or []
    chairman = council_config.get("chairman_model") or None
    if isinstance(chairman, str):
        chairman = chairman.strip() or None

    selected_personas: List[CouncilPersona] = []
    selected_models: List[str] = []

    for i, entry in enumerate(raw_entries):
        if not isinstance(entry, dict):
            continue
        if not entry.get("enabled", True):
            continue
        key = entry.get("key")
        persona = factory_by_key.get(key)
        if persona is None and key in PERSONAS_BY_KEY:
            persona = CouncilPersona(**PERSONAS_BY_KEY[key])
        if persona is None:
            continue

        # Resolve a model for this persona: explicit > factory @ index > skip
        model = entry.get("model")
        if isinstance(model, str):
            model = model.strip()
        if not model and i < len(factory_models):
            model = factory_models[i] or None
        if not model:
            # No usable model — skip rather than firing with empty string.
            logger.warning(
                "Skipping persona %s: no model assigned and no factory fallback.",
                key,
            )
            continue

        selected_personas.append(persona)
        selected_models.append(model)

    if len(selected_personas) < 2:
        # Degenerate: fall back to factory defaults so users can never accidentally
        # run a 0- or 1-member council. The API layer should also block this.
        logger.info(
            "council_config produced %d enabled personas; falling back to factory defaults.",
            len(selected_personas),
        )
        return factory_personas, factory_models, chairman

    return selected_personas, selected_models, chairman

logger = logging.getLogger(__name__)


from .providers.openai import OpenAIProvider
from .providers.anthropic import AnthropicProvider
from .providers.google import GoogleProvider
from .providers.mistral import MistralProvider
from .providers.deepseek import DeepSeekProvider
from .providers.openrouter import OpenRouterProvider
from .providers.ollama import OllamaProvider
from .providers.groq import GroqProvider
from .providers.custom_openai import CustomOpenAIProvider

# Initialize providers
PROVIDERS = {
    "openai": OpenAIProvider(),
    "anthropic": AnthropicProvider(),
    "google": GoogleProvider(),
    "mistral": MistralProvider(),
    "deepseek": DeepSeekProvider(),
    "groq": GroqProvider(),
    "openrouter": OpenRouterProvider(),
    "ollama": OllamaProvider(),
    "custom": CustomOpenAIProvider(),
}

def get_provider_for_model(model_id: str) -> Any:
    """Determine the provider for a given model ID."""
    if ":" in model_id:
        provider_name = model_id.split(":")[0]
        if provider_name in PROVIDERS:
            return PROVIDERS[provider_name]

    # Default to OpenRouter for unprefixed models (legacy support)
    return PROVIDERS["openrouter"]


async def query_model(model: str, messages: List[Dict[str, str]], timeout: float = 120.0, temperature: float = 0.7) -> Dict[str, Any]:
    """Dispatch query to appropriate provider."""
    provider = get_provider_for_model(model)
    return await provider.query(model, messages, timeout, temperature)


async def query_models_parallel(models: List[str], messages: List[Dict[str, str]]) -> Dict[str, Any]:
    """Dispatch parallel query to appropriate providers."""
    tasks = []
    model_to_task_map = {}
    
    # Group models by provider to optimize batching if supported (mostly for OpenRouter/Ollama legacy)
    # But for simplicity and modularity, we'll just spawn individual tasks for now
    # OpenRouter and Ollama wrappers might handle their own internal concurrency if we called a batch method,
    # but the base interface is single query.
    # To maintain OpenRouter's batch efficiency if it exists, we could check type, but let's stick to simple asyncio.gather first.
    
    # Actually, the previous implementation used specific batch logic for Ollama and OpenRouter.
    # We should preserve that if possible, OR just rely on asyncio.gather which is fine for HTTP clients.
    # The previous `_query_ollama_batch` was just a helper to strip prefixes.
    # `openrouter.query_models_parallel` was doing the gather.
    
    # Let's just use asyncio.gather for all. It's clean and effective.
    
    async def _query_safe(m: str):
        try:
            return m, await query_model(m, messages)
        except Exception as e:
            return m, {"error": True, "error_message": str(e)}

    tasks = [_query_safe(m) for m in models]
    results = await asyncio.gather(*tasks)
    
    return dict(results)


async def collect_pitches(
    user_query: str,
    request: Any = None,
    essay_mode: str = "topic",
    council_models: Optional[List[str]] = None,
    council_personas: Optional[List[CouncilPersona]] = None,
    user_id: Optional[str] = None,
    essay_type: str = "general",
) -> Any:
    """Stage 0 (pitch race): every council member produces a one-paragraph
    pitch (THESIS / LEAD / KEY MOVE / WHY) in parallel. Cheap exploration of
    the angle space before anyone commits to a full essay.

    Yields:
        - First yield: total_models (int)
        - Subsequent yields: per-pitch dicts {model, persona, council_index, response | error}
    """
    from .prompts import PITCH_PROMPT_DEFAULT

    settings = get_settings()

    profile: Optional[VoiceProfile] = None
    if user_id:
        try:
            profile = load_voice_profile(user_id, essay_type=essay_type)
        except Exception as e:
            logger.warning("voice profile load failed for user=%s: %s", user_id, e)
    voice_profile_block = format_voice_profile_block(profile)

    rows = load_recent_user_facts(user_id) if user_id else []
    student_profile_block = format_student_profile_block(rows)

    essay_mode_block = format_essay_mode_block(essay_mode)

    personas = (
        council_personas if council_personas is not None
        else (settings.council_personas or [])
    )
    models = council_models if council_models is not None else get_council_models()

    def _persona_name_for_index(idx: int) -> str:
        if idx < len(personas) and personas[idx].name:
            return personas[idx].name
        return ""

    def _build_prompt(idx: int) -> str:
        # Pitches use a single shared template — persona system prompts shape
        # the FULL essay in Stage 1, not the pitch. Different personas still
        # produce different pitches because of model + temperature variation.
        try:
            return PITCH_PROMPT_DEFAULT.format(
                user_query=user_query,
                essay_mode_block=essay_mode_block,
                voice_profile_block=voice_profile_block,
                student_profile_block=student_profile_block,
            )
        except Exception as e:
            logger.warning(f"Pitch prompt format failed for member {idx}: {e}")
            return f"Pitch your angle for this essay topic:\n\n{user_query}"

    # Pitches benefit from MORE creativity than full drafts — bump the temp
    # above council_temperature so the exploration is genuinely divergent.
    pitch_temp = min(0.95, settings.council_temperature + 0.2)

    yield len(models)

    async def _query_safe(idx: int, m: str):
        prompt = _build_prompt(idx)
        messages = [{"role": "user", "content": prompt}]
        try:
            return idx, m, await query_model(m, messages, temperature=pitch_temp, timeout=45.0)
        except Exception as e:
            return idx, m, {"error": True, "error_message": str(e)}

    tasks = [asyncio.create_task(_query_safe(i, m)) for i, m in enumerate(models)]
    pending = set(tasks)
    try:
        while pending:
            if request and await request.is_disconnected():
                logger.info("Client disconnected during pitch race. Cancelling tasks...")
                for t in pending:
                    t.cancel()
                raise asyncio.CancelledError("Client disconnected")
            done, pending = await asyncio.wait(
                pending, return_when=asyncio.FIRST_COMPLETED, timeout=1.0
            )
            for task in done:
                try:
                    idx, model, response = await task
                    persona_name = _persona_name_for_index(idx)
                    if response and response.get("error"):
                        yield {
                            "model": model,
                            "persona": persona_name,
                            "council_index": idx,
                            "response": None,
                            "error": True,
                            "error_message": response.get("error_message", "Unknown error"),
                        }
                        continue
                    content = (response or {}).get("content", "") if response else ""
                    if not isinstance(content, str):
                        content = str(content) if content is not None else ""
                    yield {
                        "model": model,
                        "persona": persona_name,
                        "council_index": idx,
                        "response": content,
                        "error": False,
                    }
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"Error processing pitch task: {e}")
    except asyncio.CancelledError:
        for t in tasks:
            if not t.done():
                t.cancel()
        raise


async def pick_strongest_pitch(
    user_query: str,
    pitches: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Single Gemini-Flash call to pick the strongest pitch.

    Returns {"winner_index": int, "reason": str}. On any failure, falls back
    to the first successful pitch with reason='fallback (picker error)'.
    """
    from .prompts import PITCH_PICKER_PROMPT_DEFAULT
    import json
    import re

    successful = [p for p in pitches if not p.get("error") and p.get("response")]
    if not successful:
        return {"winner_index": 0, "reason": "no successful pitches"}

    # Use stable letters so the picker reasons by label, not raw index.
    pitches_text = "\n\n".join(
        f"PITCH {i} (council member {p.get('persona') or p.get('model')}):\n"
        f"{(p.get('response') or '').strip()}"
        for i, p in enumerate(successful)
    )

    try:
        prompt = PITCH_PICKER_PROMPT_DEFAULT.format(
            user_query=user_query,
            pitches_text=pitches_text,
        )
    except Exception as e:
        logger.warning(f"pitch picker prompt format failed: {e}")
        return {
            "winner_index": pitches.index(successful[0]),
            "reason": "fallback (prompt format error)",
        }

    try:
        res = await query_model(
            "google:gemini-2.5-flash",
            [{"role": "user", "content": prompt}],
            timeout=25.0,
            temperature=0.2,
        )
    except Exception as e:
        logger.warning(f"pitch picker call failed: {e}")
        return {
            "winner_index": pitches.index(successful[0]),
            "reason": "fallback (picker error)",
        }

    if not res or res.get("error"):
        return {
            "winner_index": pitches.index(successful[0]),
            "reason": "fallback (picker returned error)",
        }

    raw = (res.get("content") or "").strip()
    parsed = None
    try:
        parsed = json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, flags=re.DOTALL)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = None

    if not isinstance(parsed, dict):
        return {
            "winner_index": pitches.index(successful[0]),
            "reason": "fallback (unparseable picker output)",
        }

    try:
        local_idx = int(parsed.get("winner_index", 0))
    except (TypeError, ValueError):
        local_idx = 0
    local_idx = max(0, min(len(successful) - 1, local_idx))
    chosen = successful[local_idx]
    return {
        "winner_index": pitches.index(chosen),
        "reason": str(parsed.get("reason") or "").strip()[:200] or "(no reason given)",
    }


async def stage1_collect_responses(
    user_query: str,
    search_context: str = "",
    request: Any = None,
    essay_mode: str = "topic",
    council_models: Optional[List[str]] = None,
    council_personas: Optional[List[CouncilPersona]] = None,
    word_target: Optional[int] = None,
    user_id: Optional[str] = None,
    essay_type: str = "general",
    library_voice: Optional[Dict[str, Any]] = None,
    shared_pitch: Optional[str] = None,
) -> Any:
    """
    Stage 1: Collect individual responses from all council models.

    Each council member at index `i` is given the system prompt from
    `council_personas[i]` (the 4 essay-writing personas by default).
    Members whose index exceeds the persona list fall back to the generic
    settings.stage1_prompt.

    Args:
        user_query: The user's question
        search_context: Optional web search results to provide context
        request: FastAPI request object for checking disconnects
        essay_mode: 'topic' (write from scratch) or 'draft' (refine user's draft)
        council_models: per-call override; if None, uses settings.council_models
        council_personas: per-call override; if None, uses settings.council_personas
        word_target: optional length target rendered into {word_target_block}

    Yields:
        - First yield: total_models (int)
        - Subsequent yields: Individual model results (dict)
    """
    settings = get_settings()

    # Build search context block if search results provided
    search_context_block = ""
    if search_context:
        from .prompts import STAGE1_SEARCH_CONTEXT_TEMPLATE
        search_context_block = STAGE1_SEARCH_CONTEXT_TEMPLATE.format(search_context=search_context)

    # Render the user's voice profile (empty string if not configured).
    # Loaded per-user from Supabase. Available to every persona so users
    # can opt-in via custom templates; by default only The Voice Guardian's
    # template references it.
    profile: Optional[VoiceProfile] = None
    if user_id:
        try:
            profile = load_voice_profile(user_id, essay_type=essay_type)
        except Exception as e:
            logger.warning("voice profile load failed for user=%s: %s", user_id, e)
    voice_profile_block = format_voice_profile_block(profile)

    rows = load_recent_user_facts(user_id) if user_id else []
    student_profile_block = format_student_profile_block(rows)

    # Library-voice scaffolding (invisible to user). Borrowed for rhythm /
    # cadence only — content stays the user's. Empty string if no library
    # voice is provided.
    library_voice_block = format_library_voice_block(library_voice)

    # Tell every persona explicitly whether the input is a topic to
    # expand into an essay or a draft to refine.
    essay_mode_block = format_essay_mode_block(essay_mode)

    # Optional "TARGET LENGTH: ~N words." block.
    word_target_block = format_word_target_block(word_target)

    from .prompts import STAGE1_PROMPT_DEFAULT
    fallback_template = settings.stage1_prompt or STAGE1_PROMPT_DEFAULT
    personas = council_personas if council_personas is not None else (settings.council_personas or [])

    # When a shared pitch was picked in the pitch race, prepend it to every
    # persona's prompt so all 4 essays converge on the same THESIS / LEAD /
    # KEY MOVE. This is what makes Stage 2 synthesis tractable later: the
    # 4 essays are variations on one theme, not 4 different visions.
    shared_pitch_prefix = ""
    if shared_pitch and shared_pitch.strip():
        shared_pitch_prefix = (
            "COUNCIL-AGREED ANGLE (write your essay using THIS thesis, "
            "lead, and key structural move — do not propose a different "
            "angle; differ in execution, not in angle):\n\n"
            f"{shared_pitch.strip()}\n\n---\n\n"
        )

    def _build_prompt_for_index(idx: int) -> str:
        """Pick persona prompt for council member `idx`, with fallbacks."""
        template = None
        if idx < len(personas) and personas[idx].prompt:
            template = personas[idx].prompt
        if not template:
            template = fallback_template

        try:
            body = template.format(
                user_query=user_query,
                search_context_block=search_context_block,
                voice_profile_block=voice_profile_block,
                student_profile_block=student_profile_block,
                library_voice_block=library_voice_block,
                essay_mode_block=essay_mode_block,
                word_target_block=word_target_block,
            )
        except (KeyError, AttributeError, TypeError) as e:
            logger.warning(
                f"Error formatting Stage 1 prompt for member {idx}: {e}. Using bare fallback."
            )
            if search_context_block:
                body = f"{search_context_block}\n\nTopic or draft from user:\n{user_query}"
            else:
                body = user_query
        return shared_pitch_prefix + body

    # Prepare tasks for all models
    models = council_models if council_models is not None else get_council_models()

    # Yield total count first
    yield len(models)

    council_temp = settings.council_temperature

    def _persona_name_for_index(idx: int) -> str:
        if idx < len(personas) and personas[idx].name:
            return personas[idx].name
        return ""

    def _temp_for_index(idx: int) -> float:
        """Per-persona temperature override falls back to council_temp."""
        if idx < len(personas):
            t = getattr(personas[idx], "temperature", None)
            if isinstance(t, (int, float)) and 0.0 <= float(t) <= 2.0:
                return float(t)
        return council_temp

    async def _query_safe(idx: int, m: str):
        prompt = _build_prompt_for_index(idx)
        messages = [{"role": "user", "content": prompt}]
        try:
            return idx, m, await query_model(m, messages, temperature=_temp_for_index(idx))
        except Exception as e:
            return idx, m, {"error": True, "error_message": str(e)}

    # Create tasks (preserve council member index so we map persona -> model)
    tasks = [asyncio.create_task(_query_safe(i, m)) for i, m in enumerate(models)]
    
    # Process as they complete
    pending = set(tasks)
    try:
        while pending:
            # Check for client disconnect
            if request and await request.is_disconnected():
                logger.info("Client disconnected during Stage 1. Cancelling tasks...")
                for t in pending:
                    t.cancel()
                raise asyncio.CancelledError("Client disconnected")

            # Wait for the next task to complete (with timeout to check for disconnects)
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED, timeout=1.0)

            for task in done:
                try:
                    idx, model, response = await task
                    persona_name = _persona_name_for_index(idx)

                    result = None
                    if response is not None:
                        if response.get('error'):
                            # Include failed models with error info
                            result = {
                                "model": model,
                                "persona": persona_name,
                                "council_index": idx,
                                "response": None,
                                "error": response.get('error'),
                                "error_message": response.get('error_message', 'Unknown error')
                            }
                        else:
                            # Successful response - ensure content is always a string
                            content = response.get('content', '')
                            if not isinstance(content, str):
                                # Handle case where API returns non-string content (array, object, etc.)
                                content = str(content) if content is not None else ''
                            result = {
                                "model": model,
                                "persona": persona_name,
                                "council_index": idx,
                                "response": content,
                                "error": None
                            }

                    if result:
                        yield result
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"Error processing Stage 1 task result: {e}")

    except asyncio.CancelledError:
        # Ensure all tasks are cancelled if we get cancelled
        for t in tasks:
            if not t.done():
                t.cancel()
        raise


async def pick_strongest_draft(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Single Gemini-Flash call to identify which of the Stage 1 essays is the
    strongest. Becomes the SPINE that Stage 2 critiques and Stage 3 revises.

    Returns {"winner_index": int, "reason": str}. Falls back to the first
    successful draft on any failure.
    """
    import json
    import re

    successful = [
        (i, r) for i, r in enumerate(stage1_results)
        if not r.get("error") and r.get("response")
    ]
    if not successful:
        return {"winner_index": 0, "reason": "no successful drafts"}

    drafts_text = "\n\n".join(
        f"DRAFT {i} ({(r.get('persona') or r.get('model') or 'unknown')}):\n"
        f"{(r.get('response') or '').strip()}"
        for i, r in successful
    )

    prompt = (
        "You are picking the strongest essay from a council of drafts. "
        "All drafts respond to the same topic and started from the same "
        "agreed angle, but each council member had a different structural "
        "commitment. Pick the draft most worth keeping as the spine for "
        "revision.\n\n"
        "Prefer the draft whose specificity, voice, and structural decision "
        "would survive a careful edit. Reject drafts that hedge or read like "
        "AI-speak.\n\n"
        f"Topic:\n{user_query}\n\n"
        f"Drafts:\n{drafts_text}\n\n"
        "Output STRICT JSON, no commentary, no fences:\n"
        '{"winner_index": N, "reason": "<one short sentence>"}\n\n'
        "N is the index used in the DRAFT N header above."
    )

    try:
        res = await query_model(
            "google:gemini-2.5-flash",
            [{"role": "user", "content": prompt}],
            timeout=30.0,
            temperature=0.2,
        )
    except Exception as e:
        logger.warning(f"spine picker call failed: {e}")
        return {
            "winner_index": successful[0][0],
            "reason": "fallback (picker error)",
        }
    if not res or res.get("error"):
        return {
            "winner_index": successful[0][0],
            "reason": "fallback (picker returned error)",
        }

    raw = (res.get("content") or "").strip()
    parsed = None
    try:
        parsed = json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, flags=re.DOTALL)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = None

    if not isinstance(parsed, dict):
        return {
            "winner_index": successful[0][0],
            "reason": "fallback (unparseable picker output)",
        }

    try:
        idx = int(parsed.get("winner_index", successful[0][0]))
    except (TypeError, ValueError):
        idx = successful[0][0]
    valid_indices = {i for i, _ in successful}
    if idx not in valid_indices:
        idx = successful[0][0]
    return {
        "winner_index": idx,
        "reason": str(parsed.get("reason") or "").strip()[:200] or "(no reason given)",
    }


async def stage2_collect_critiques(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
    spine_index: int,
    request: Any = None,
    essay_mode: str = "topic",
    user_id: Optional[str] = None,
    essay_type: str = "general",
) -> Any:
    """Stage 2 (replaces rankings in 0.4.0). Every council member writes a
    short surgical critique of the SPINE draft: CUT / SHARPEN / KEEP /
    BORROW. The chairman then revises the spine using these critiques.

    Yields:
        - Subsequent yields: per-critique dicts {model, persona, council_index, critique | error}
    """
    from .prompts import STAGE2_CRITIQUE_PROMPT_DEFAULT

    settings = get_settings()

    successful = [r for r in stage1_results if not r.get("error") and r.get("response")]
    if not successful or spine_index < 0 or spine_index >= len(stage1_results):
        return

    spine = stage1_results[spine_index]
    spine_text = (spine.get("response") or "").strip()

    others = [
        r for i, r in enumerate(stage1_results)
        if i != spine_index and not r.get("error") and r.get("response")
    ]
    other_drafts_text = "\n\n".join(
        f"DRAFT {chr(65 + i)} ({(r.get('persona') or r.get('model') or 'unknown')}):\n"
        f"{(r.get('response') or '').strip()}"
        for i, r in enumerate(others)
    ) or "(no other drafts succeeded)"

    profile: Optional[VoiceProfile] = None
    if user_id:
        try:
            profile = load_voice_profile(user_id, essay_type=essay_type)
        except Exception as e:
            logger.warning("voice profile load failed for user=%s: %s", user_id, e)
    voice_profile_block = format_voice_profile_block(profile)

    rows = load_recent_user_facts(user_id) if user_id else []
    student_profile_block = format_student_profile_block(rows)

    essay_mode_block = format_essay_mode_block(essay_mode)

    try:
        critique_prompt = STAGE2_CRITIQUE_PROMPT_DEFAULT.format(
            user_query=user_query,
            essay_mode_block=essay_mode_block,
            spine_text=spine_text,
            other_drafts_text=other_drafts_text,
            voice_profile_block=voice_profile_block,
            student_profile_block=student_profile_block,
        )
    except (KeyError, AttributeError, TypeError) as e:
        logger.warning(f"critique prompt format failed: {e}")
        critique_prompt = (
            f"Critique this essay draft surgically (CUT/SHARPEN/KEEP/BORROW):\n\n"
            f"{spine_text}"
        )

    messages = [{"role": "user", "content": critique_prompt}]

    # Use the dedicated Stage 2 temperature (low, for surgical output).
    crit_temp = settings.stage2_temperature

    # Critiques run on every successful Stage 1 model — the same models that
    # wrote the drafts critique the spine. No model critiques its own draft
    # of course, but mixed authorship is fine: a model can usefully critique
    # the spine even if it wrote one of the OTHER drafts.
    critic_models = [r["model"] for r in successful]

    async def _query_safe(idx: int, m: str):
        try:
            return idx, m, await query_model(m, messages, temperature=crit_temp, timeout=60.0)
        except Exception as e:
            return idx, m, {"error": True, "error_message": str(e)}

    tasks = [
        asyncio.create_task(_query_safe(i, m)) for i, m in enumerate(critic_models)
    ]
    pending = set(tasks)
    try:
        while pending:
            if request and await request.is_disconnected():
                logger.info("Client disconnected during Stage 2 critiques. Cancelling...")
                for t in pending:
                    t.cancel()
                raise asyncio.CancelledError("Client disconnected")
            done, pending = await asyncio.wait(
                pending, return_when=asyncio.FIRST_COMPLETED, timeout=1.0
            )
            for task in done:
                try:
                    idx, model, response = await task
                    persona_name = (successful[idx].get("persona") or "") if idx < len(successful) else ""
                    if response and response.get("error"):
                        yield {
                            "model": model,
                            "persona": persona_name,
                            "council_index": idx,
                            "critique": None,
                            "error": True,
                            "error_message": response.get("error_message", "Unknown error"),
                        }
                        continue
                    content = (response or {}).get("content", "") if response else ""
                    if not isinstance(content, str):
                        content = str(content) if content is not None else ""
                    yield {
                        "model": model,
                        "persona": persona_name,
                        "council_index": idx,
                        "critique": content,
                        "error": False,
                    }
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"Error processing Stage 2 critique task: {e}")
    except asyncio.CancelledError:
        for t in tasks:
            if not t.done():
                t.cancel()
        raise



async def stage3_synthesize_final(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]],
    search_context: str = "",
    essay_mode: str = "topic",
    chairman_model_override: Optional[str] = None,
    word_target: Optional[int] = None,
    user_id: Optional[str] = None,
    essay_type: str = "general",
    library_voice: Optional[Dict[str, Any]] = None,
    in_flight_qa_block: str = "",
    spine_index: int = 0,
) -> Dict[str, Any]:
    """
    Stage 3 (revision, not synthesis). The chairman REVISES the spine
    draft picked in pick_strongest_draft() using the consolidated
    critiques from stage2_collect_critiques(). This is a directed
    revision task — much easier and more reliable than fusing 4 full
    essays into 1 from scratch.

    Args:
        spine_index: which Stage 1 result is the spine. Defaults to 0
            if not provided (legacy callers).
    """
    settings = get_settings()
    from .prompts import STAGE3_REVISION_PROMPT_DEFAULT

    # Pick the spine. Fall back to the first successful Stage 1 result if
    # the requested index is out of bounds or failed.
    successful_drafts = [r for r in stage1_results if not r.get("error") and r.get("response")]
    if not successful_drafts:
        return {
            "model": chairman_model_override or get_chairman_model(),
            "response": "Error: no Stage 1 drafts succeeded.",
            "error": True,
            "error_message": "no successful drafts",
        }

    if 0 <= spine_index < len(stage1_results) and stage1_results[spine_index].get("response"):
        spine = stage1_results[spine_index]
    else:
        spine = successful_drafts[0]
    spine_text = (spine.get("response") or "").strip()

    # Consolidated critique text from Stage 2 (CUT / SHARPEN / KEEP / BORROW).
    critiques_text = "\n\n---\n\n".join(
        f"FROM {r.get('persona') or r.get('model') or 'critic'}:\n{(r.get('critique') or '').strip()}"
        for r in stage2_results
        if not r.get("error") and r.get("critique")
    ) or "(no critiques succeeded — revise the spine using your own judgment)"

    search_context_block = ""
    if search_context:
        search_context_block = f"Context from Web Search:\n{search_context}\n"

    # User voice profile.
    profile: Optional[VoiceProfile] = None
    if user_id:
        try:
            profile = load_voice_profile(user_id, essay_type=essay_type)
        except Exception as e:
            logger.warning(
                "Chairman: voice profile load failed for user=%s: %s", user_id, e
            )
    voice_profile_block = format_voice_profile_block(profile)

    fact_rows = load_recent_user_facts(user_id) if user_id else []
    student_profile_block = format_student_profile_block(fact_rows)

    # Fold any interim Q&A answers into student_profile_block so the
    # revision prompt picks them up automatically.
    if in_flight_qa_block and in_flight_qa_block.strip():
        student_profile_block = (
            (student_profile_block + "\n\n") if student_profile_block else ""
        ) + in_flight_qa_block.strip()

    library_voice_block = format_library_voice_block(library_voice)
    essay_mode_block = format_essay_mode_block(essay_mode)
    word_target_block = format_word_target_block(word_target)

    # The user-customizable stage3_prompt now expects revision-style fields
    # (spine_text + critiques_text). If the user previously customized the
    # stage 3 prompt, it may use the OLD fields (stage1_text, stage2_text)
    # and fail to format. Fall back to the default revision prompt in that
    # case so the run still completes.
    prompt_template = settings.stage3_prompt or STAGE3_REVISION_PROMPT_DEFAULT
    try:
        chairman_prompt = prompt_template.format(
            user_query=user_query,
            spine_text=spine_text,
            critiques_text=critiques_text,
            search_context_block=search_context_block,
            voice_profile_block=voice_profile_block,
            student_profile_block=student_profile_block,
            library_voice_block=library_voice_block,
            essay_mode_block=essay_mode_block,
            word_target_block=word_target_block,
        )
    except (KeyError, AttributeError, TypeError) as e:
        logger.warning(
            f"Stage 3 prompt format failed (likely an old custom prompt using "
            f"stage1_text/stage2_text): {e}. Falling back to default revision prompt."
        )
        try:
            chairman_prompt = STAGE3_REVISION_PROMPT_DEFAULT.format(
                user_query=user_query,
                spine_text=spine_text,
                critiques_text=critiques_text,
                search_context_block=search_context_block,
                voice_profile_block=voice_profile_block,
                student_profile_block=student_profile_block,
                library_voice_block=library_voice_block,
                essay_mode_block=essay_mode_block,
                word_target_block=word_target_block,
            )
        except Exception:
            chairman_prompt = (
                f"Revise this essay using the critique notes:\n\n"
                f"SPINE:\n{spine_text}\n\nCRITIQUES:\n{critiques_text}"
            )

    is_default_prompt = (
        not settings.stage3_prompt
        or settings.stage3_prompt.strip() == STAGE3_REVISION_PROMPT_DEFAULT.strip()
    )

    if is_default_prompt:
        messages = [
            {
                "role": "system",
                "content": (
                    "You are the Chairman of an essay-writing council. "
                    "Revise the spine draft below using the council's critique "
                    "notes. You are improving an existing essay, not synthesizing "
                    "from scratch. Apply every CUT, SHARPEN, KEEP, and BORROW "
                    "directive. If the user has provided a voice profile, every "
                    "rule in it overrides your stylistic preferences."
                ),
            },
            {"role": "user", "content": chairman_prompt},
        ]
    else:
        messages = [{"role": "user", "content": chairman_prompt}]

    # Query the chairman model with error handling. Per-call override beats
    # settings.chairman_model.
    chairman_model = (
        chairman_model_override.strip()
        if isinstance(chairman_model_override, str) and chairman_model_override.strip()
        else get_chairman_model()
    )
    chairman_temp = settings.chairman_temperature

    try:
        response = await query_model(chairman_model, messages, temperature=chairman_temp)

        # Check for error in response
        if response is None or response.get('error'):
            error_msg = response.get('error_message', 'Unknown error') if response else 'No response received'
            return {
                "model": chairman_model,
                "response": f"Error synthesizing final answer: {error_msg}",
                "error": True,
                "error_message": error_msg
            }

        # Combine reasoning and content if available
        content = response.get('content') or ''
        reasoning = response.get('reasoning') or response.get('reasoning_details') or ''
        
        final_response = content
        if reasoning and not content:
            # If only reasoning is provided (some reasoning models do this)
            final_response = f"**Reasoning:**\n{reasoning}"
        elif reasoning and content:
            # If both are provided, prepend reasoning in a collapsible block or just prepend
            # For now, we'll just prepend it clearly
            final_response = f"<think>\n{reasoning}\n</think>\n\n{content}"

        if not final_response:
             final_response = "No response generated by the Chairman."

        return {
            "model": chairman_model,
            "response": final_response,
            "error": False
        }

    except Exception as e:
        logger.error(f"Unexpected error in Stage 3 synthesis: {e}")
        return {
            "model": chairman_model,
            "response": f"Error: Unable to generate final synthesis due to unexpected error.",
            "error": True,
            "error_message": str(e)
        }


async def generate_conversation_title(user_query: str) -> str:
    """
    Generate a short title for a conversation based on the first user message.

    Uses a simple heuristic (first few words) to avoid unnecessary API calls.

    Args:
        user_query: The first user message

    Returns:
        A short title (max 50 chars)
    """
    # Validate input
    if not user_query or not isinstance(user_query, str):
        return "Untitled Conversation"

    # Simple heuristic: take first 50 chars
    title = user_query.strip()

    # If empty after stripping, return default
    if not title:
        return "Untitled Conversation"

    # Remove quotes if present
    title = title.strip('"\'')

    # Truncate if too long
    if len(title) > 50:
        title = title[:47] + "..."

    return title


def generate_search_query(user_query: str) -> str:
    """Return user query directly for web search (passthrough).
    
    Modern search engines (DuckDuckGo, Brave, Tavily) handle 
    natural language queries well without optimization.
    
    Args:
        user_query: The user's full question
    
    Returns:
        User query truncated to 100 characters for safety
    """
    return user_query[:100]  # Truncate for safety
