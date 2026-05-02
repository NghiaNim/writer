"""FastAPI backend for LLM Council."""

from contextlib import asynccontextmanager

import posthog
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
import os
import uuid
import json
import asyncio

from . import storage
from fastapi import Depends
from .auth import AuthUser, get_current_user, router as auth_router
from .council import (
    generate_conversation_title,
    generate_search_query,
    stage1_collect_responses,
    stage2_collect_rankings,
    stage3_synthesize_final,
    calculate_aggregate_rankings,
    resolve_council_config,
    PROVIDERS,
)
from .council_config import (
    factory_council_config,
    router as council_config_router,
)
from .search import perform_web_search, SearchProvider
from .sessions import router as sessions_router
from .settings import get_settings, update_settings, Settings, DEFAULT_COUNCIL_MODELS, DEFAULT_CHAIRMAN_MODEL, AVAILABLE_MODELS
from .supabase_client import get_supabase
from .voice_profile import (
    VoiceProfile,
    VoiceProfileSaveBody,
    load_voice_profile,
    save_voice_profile,
    add_suggestions,
    accept_suggestion,
    reject_suggestion,
)
from .voice_library import pick_random_voice, get_voice_by_id


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: initialize and flush PostHog.

    If POSTHOG_PROJECT_TOKEN is missing, we set a placeholder key and disable
    the client so capture() calls become no-ops instead of crashing endpoints.
    """
    token = os.environ.get("POSTHOG_PROJECT_TOKEN", "").strip()
    if token:
        posthog.api_key = token
        posthog.disabled = False
    else:
        # Placeholder satisfies posthog's setup() check; disabled=True drops events.
        posthog.api_key = "phc_disabled_no_token_set"
        posthog.disabled = True
        print("WARN: POSTHOG_PROJECT_TOKEN not set — posthog disabled")
    posthog.host = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com")
    posthog.enable_exception_autocapture = True
    yield
    if not posthog.disabled:
        posthog.flush()


app = FastAPI(title="LLM Council Plus API", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Lightweight one-shot LLM helpers (intake + voice-rule extraction)
# ---------------------------------------------------------------------------
#
# These are deliberately *not* run through the council. Each is a single
# strict-JSON call to a fast model. Failures fall back to safe defaults so
# the UI never deadlocks waiting on a flaky completion.


def _safe_json_loads(s: str) -> Optional[Dict[str, Any]]:
    """Pull the first valid JSON object out of an LLM response."""
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        pass
    import re as _r

    m = _r.search(r"\{.*\}", s, flags=_r.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


async def _generate_intake_questions(topic: str, audience: str, essay_type: str) -> List[str]:
    """Generate 3-5 probing questions tailored to topic+audience.

    Returns a list of strings. On any failure, falls back to a small set of
    safe, generic prompts so the UI keeps moving.
    """
    audience_part = f" The intended audience is: {audience}." if audience else ""
    sys_prompt = (
        "You are an essay coach helping a student articulate the most interesting "
        "version of an idea. Given a topic and audience, ask 3-5 short, "
        "high-leverage questions that surface a non-obvious thesis. Each question "
        "should be one sentence, conversational, and aimed at uncovering "
        "concrete details, contradictions, or surprising stakes. Avoid generic "
        "writing-class prompts. Avoid 'why is this important?'."
    )
    user_prompt = (
        f"TOPIC: {topic}.{audience_part}\n"
        f"ESSAY TYPE: {essay_type}.\n\n"
        "Return STRICT JSON, no prose:\n"
        '{"questions": ["...", "...", "..."]}'
    )
    from .council import query_model

    try:
        res = await query_model(
            _INTAKE_MODEL,
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            timeout=45.0,
            temperature=0.7,
        )
    except Exception as e:
        print(f"WARN: intake questions LLM call failed: {e}")
        res = None

    parsed = _safe_json_loads((res or {}).get("content", "")) if res else None
    if isinstance(parsed, dict):
        qs = parsed.get("questions")
        if isinstance(qs, list):
            cleaned = [str(q).strip() for q in qs if str(q).strip()]
            if 3 <= len(cleaned) <= 7:
                return cleaned[:5]

    # Fallback prompts. Generic enough to never be wrong, weak enough that
    # we'll see in logs when the LLM call regressed.
    return [
        "What's the strongest specific moment, scene, or example you'd build this around?",
        "What's the non-obvious thing you want this audience to understand?",
        "What would someone who already agrees with you still learn?",
        "What contradiction or tension lives inside this topic for you?",
        "What's one detail you'd be embarrassed to leave out?",
    ]


async def _generate_example_answer(topic: str, audience: str, question: str) -> str:
    """Generate one short example answer for a single intake question.

    The example is meant to unstick a user who's staring at a blank textarea —
    it should be specific and concrete (so it actually demonstrates what a good
    answer looks like) but deliberately *different in angle* from the most
    obvious read of the topic, so it nudges rather than anchors.
    """
    audience_part = f"\nAUDIENCE: {audience}" if audience else ""
    sys_prompt = (
        "You are an essay coach. The student is staring at a blank textarea "
        "and needs a sample answer to unstick them. Write ONE example response "
        "(2-3 sentences, first person) to the question below, grounded in the "
        "given topic. Make it concrete and specific — name a moment, a detail, "
        "a number, a contradiction. Avoid generic platitudes. Pick a non-obvious "
        "angle so the student is nudged, not anchored. Do not preface with "
        "'For example' or quotation marks — just the answer text."
    )
    user_prompt = (
        f"TOPIC: {topic}{audience_part}\n"
        f"QUESTION: {question}\n\n"
        "Return STRICT JSON, no prose:\n"
        '{"example": "..."}'
    )
    from .council import query_model

    try:
        res = await query_model(
            _INTAKE_MODEL,
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            timeout=30.0,
            temperature=0.85,
        )
    except Exception as e:
        print(f"WARN: intake example LLM call failed: {e}")
        res = None

    parsed = _safe_json_loads((res or {}).get("content", "")) if res else None
    if isinstance(parsed, dict):
        ex = parsed.get("example")
        if isinstance(ex, str) and ex.strip():
            return ex.strip()
    # Fallback raw content (strip any code fences) so the user still sees something.
    raw = (res or {}).get("content", "").strip() if res else ""
    if raw:
        return raw[:600]
    return ""


async def _generate_core_idea(
    topic: str, audience: str, qa: List[Dict[str, str]]
) -> str:
    """Distill the user's intake answers into a 1-paragraph core-idea brief."""
    audience_part = f"\nAUDIENCE: {audience}" if audience else ""
    qa_block = "\n".join(
        f"- Q: {(item or {}).get('question','').strip()}\n  A: {(item or {}).get('answer','').strip()}"
        for item in qa
        if (item or {}).get("answer")
    ) or "(no answers provided)"

    sys_prompt = (
        "You are an essay coach. Given a topic, audience, and a short Q&A "
        "from the writer, write one tight paragraph (4-6 sentences) that "
        "captures the core idea, the non-obvious claim, and the most "
        "promising specific example or scene. Write directly, no hedging, "
        "no preamble, no headings. Sound like the writer's own thinking, "
        "sharpened. Output the paragraph only."
    )
    user_prompt = (
        f"TOPIC: {topic}{audience_part}\n\n"
        f"Q&A:\n{qa_block}\n\n"
        "Now write the core-idea paragraph."
    )
    from .council import query_model

    try:
        res = await query_model(
            _INTAKE_MODEL,
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            timeout=60.0,
            temperature=0.8,
        )
    except Exception as e:
        print(f"WARN: core-idea LLM call failed: {e}")
        return ""

    if not res or res.get("error"):
        return ""
    content = (res.get("content") or "").strip()
    return content


_REFINEMENT_ESSAY_MAX_CHARS = 14_000


async def _generate_refinement_suggestions(
    essay_text: str, original_brief: str
) -> List[Dict[str, str]]:
    """5–7 essay-specific refinement ideas. Single LLM call; empty list on failure."""
    essay = (essay_text or "").strip()
    if not essay:
        return []
    if len(essay) > _REFINEMENT_ESSAY_MAX_CHARS:
        essay = (
            essay[:_REFINEMENT_ESSAY_MAX_CHARS]
            + "\n\n[... excerpt truncated for processing ...]"
        )

    brief = (original_brief or "").strip()
    brief_part = (
        f"\nORIGINAL INTAKE OR BRIEF (context only):\n{brief}\n" if brief else ""
    )

    sys_prompt = (
        "You are an editorial coach reviewing a specific essay. Read every word.\n"
        "Produce exactly 6 distinct, surgical refinement instructions for another LLM editor.\n\n"
        "RULES — every instruction must follow this structure:\n"
        "1. Quote a specific phrase, sentence, or section from the essay in quotation marks.\n"
        "2. One sentence diagnosing what is weak, vague, or underdeveloped there.\n"
        "3. Two to three sentences prescribing the exact change: what to cut, rewrite, add, or restructure — be specific about location and method.\n"
        "4. One sentence naming the intended effect on the reader.\n"
        "Total: 4–6 sentences per instruction. Never write generic advice ('add more detail', 'improve transitions') without first quoting the essay.\n\n"
        "Cover these six dimensions, one each:\n"
        "  A. Opening hook — is the first sentence doing enough work?\n"
        "  B. Central argument or thesis — is the core claim clear and defensible?\n"
        "  C. Evidence or specificity — where is the essay too abstract or relying on assertion?\n"
        "  D. Voice and tone — where does the writing feel flat, generic, or inconsistent with the rest?\n"
        "  E. Structure or transitions — where does the logic stumble or a section feel out of order?\n"
        "  F. Ending — does the final paragraph earn its landing?\n\n"
        "Chip labels: 3–5 words, start with an imperative verb (e.g. 'Rewrite the opening hook'), no trailing period."
    )
    user_prompt = (
        f"ESSAY:\n{essay}\n"
        f"{brief_part}\n"
        "Return STRICT JSON only — no markdown fences, no commentary:\n"
        '{"suggestions":[{"label":"Imperative verb + 3-4 words","instruction":"Quote from essay. Diagnosis. Precise prescription (2-3 sentences). Intended effect."}]}'
    )
    from .council import query_model

    try:
        res = await query_model(
            _INTAKE_MODEL,
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            timeout=55.0,
            temperature=0.65,
        )
    except Exception as e:
        print(f"WARN: refinement suggestions LLM call failed: {e}")
        res = None

    parsed = _safe_json_loads((res or {}).get("content", "")) if res else None
    out: List[Dict[str, str]] = []
    if isinstance(parsed, dict):
        items = parsed.get("suggestions")
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                label = str(item.get("label") or "").strip()
                inst = str(item.get("instruction") or "").strip()
                if label and inst and len(label) <= 88:
                    out.append({"label": label, "instruction": inst})
    if 3 <= len(out) <= 12:
        return out[:7]
    return []


async def _extract_voice_rules_via_llm(samples: List[str]) -> Dict[str, Any]:
    """Read user voice samples and return {rules, inferred_style}.

    Rules are short, prescriptive, and concrete (e.g. "no em-dashes",
    "lean shorter sentences", "avoid 'delve into'"). Inferred style is a
    1-2 sentence summary.
    """
    joined = "\n\n---\n\n".join(s.strip() for s in samples if s and s.strip())
    if not joined:
        return {"rules": [], "inferred_style": ""}

    sys_prompt = (
        "You are a writing-style analyst. Given one or more samples of a "
        "user's writing, extract 5-8 short, concrete style rules another "
        "model could follow to imitate their voice. Each rule must be one "
        "imperative sentence under 90 characters. Skip platitudes; favor "
        "specific moves (sentence length, punctuation habits, rhythm, "
        "favored words to use or avoid). Then write a 1-2 sentence "
        "'inferred_style' summary."
    )
    user_prompt = (
        f"SAMPLES:\n{joined}\n\n"
        "Return STRICT JSON, no prose:\n"
        '{"rules": ["...", "..."], "inferred_style": "..."}'
    )
    from .council import query_model

    try:
        res = await query_model(
            _INTAKE_MODEL,
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            timeout=60.0,
            temperature=0.4,
        )
    except Exception as e:
        print(f"WARN: voice rule extraction failed: {e}")
        return {"rules": [], "inferred_style": ""}

    parsed = _safe_json_loads((res or {}).get("content", "")) if res else None
    if not isinstance(parsed, dict):
        return {"rules": [], "inferred_style": ""}
    rules = parsed.get("rules") or []
    if not isinstance(rules, list):
        rules = []
    cleaned_rules = [str(r).strip() for r in rules if str(r).strip()]
    style = parsed.get("inferred_style") or ""
    if not isinstance(style, str):
        style = str(style)
    return {"rules": cleaned_rules[:8], "inferred_style": style.strip()}

# Phase 1 (Supabase auth): /auth/signup, /auth/login, /auth/logout, /auth/me
app.include_router(auth_router)
# Phase 3 (3-step input flow): /sessions/* — auth-required
app.include_router(sessions_router)
# Extension #1: per-user default council config (auth-required)
app.include_router(council_config_router)

# Enable CORS. Local dev hits localhost:5173/5174/3000; production hits the
# hosted frontend domain(s) listed in FRONTEND_ORIGINS (comma-separated env
# var, e.g. "https://essaycoach.app,https://essaycoach.vercel.app"). Both are
# matched via a single regex so credentials work everywhere.
import os as _os
import re as _re

_patterns = [
    # Local dev (any port on common loopback/.local hostnames).
    r"http://(localhost|127\.0\.0\.1|0\.0\.0\.0|[\w.-]+\.local)(:\d+)?",
    # Common managed-frontend hosts so the app works without needing an env
    # var on day one. Tighten by setting FRONTEND_ORIGINS if you want to
    # restrict to a specific domain.
    r"https://[\w-]+(--[\w-]+)?\.vercel\.app",
    r"https://[\w-]+\.netlify\.app",
    r"https://[\w-]+\.onrender\.com",
    r"https://[\w-]+\.pages\.dev",
    r"https://[\w-]+\.github\.io",
]
for o in (_os.environ.get("FRONTEND_ORIGINS") or "").split(","):
    o = o.strip()
    if o:
        _patterns.append(_re.escape(o))

_origin_regex = "|".join(f"({p})" for p in _patterns)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateConversationRequest(BaseModel):
    """Request to create a new conversation."""
    pass


class SendMessageRequest(BaseModel):
    """Request to send a message in a conversation."""
    content: str
    web_search: bool = False
    execution_mode: str = "full"  # 'chat_only', 'chat_ranking', 'full'
    # Phase 4: how to interpret `content`
    #   'topic' -> the user supplied an essay topic; council writes from scratch
    #   'draft' -> the user supplied their own draft; council refines while preserving voice
    essay_mode: str = "topic"
    # Extension #1: optional pointer to an essay_sessions row. When provided,
    # the backend pulls word_target + council_config off that session and uses
    # them for stage 1/2/3. Falls back to the user's default council config if
    # the session has no override, then to factory defaults.
    session_id: Optional[str] = None


class ConversationMetadata(BaseModel):
    """Conversation metadata for list view."""
    id: str
    created_at: str
    title: str
    message_count: int


class Conversation(BaseModel):
    """Full conversation with all messages."""
    id: str
    created_at: str
    title: str
    messages: List[Dict[str, Any]]


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "LLM Council API"}


@app.get("/healthz")
async def healthz():
    """Liveness probe used by Render's health check and the frontend warm-up
    ping. Intentionally cheap: no DB hit, no auth, no external calls. The
    frontend pings this on app mount so the user doesn't pay the full cold
    start when they actually submit an essay.
    """
    return {"ok": True}


@app.get("/api/conversations", response_model=List[ConversationMetadata])
async def list_conversations():
    """List all conversations (metadata only)."""
    return storage.list_conversations()


@app.post("/api/conversations", response_model=Conversation)
async def create_conversation(request: CreateConversationRequest):
    """Create a new conversation."""
    conversation_id = str(uuid.uuid4())
    conversation = storage.create_conversation(conversation_id)
    return conversation


@app.get("/api/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation(conversation_id: str):
    """Get a specific conversation with all its messages."""
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    """Delete a conversation."""
    deleted = storage.delete_conversation(conversation_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"status": "deleted"}


@app.post("/api/conversations/{conversation_id}/message/stream")
async def send_message_stream(
    conversation_id: str,
    body: SendMessageRequest,
    request: Request,
    user: AuthUser = Depends(get_current_user),
):
    """Send a message and stream the 3-stage council process.

    Auth-required (extension #1). Resolves the council config to use in the
    following order:
        1. body.session_id -> essay_sessions.council_config (per-essay override)
        2. user_council_config row (per-user default)
        3. factory_council_config() (built-in default)

    Same precedence for `word_target`.
    """
    # Validate execution_mode
    valid_modes = ["chat_only", "chat_ranking", "full"]
    if body.execution_mode not in valid_modes:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid execution_mode. Must be one of: {valid_modes}"
        )

    # Validate essay_mode (Phase 4)
    valid_essay_modes = ["topic", "draft"]
    if body.essay_mode not in valid_essay_modes:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid essay_mode. Must be one of: {valid_essay_modes}"
        )

    # Check if conversation exists
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Check if this is the first message
    is_first_message = len(conversation["messages"]) == 0

    # ------------------------------------------------------------------
    # Resolve the council config + word target for this request.
    # ------------------------------------------------------------------
    supabase = get_supabase()
    raw_council_config: Optional[Dict[str, Any]] = None
    word_target: Optional[int] = None
    session_topic: Optional[str] = None
    session_so_what: Optional[str] = None
    session_essay_type: Optional[str] = None

    if body.session_id:
        try:
            session_row = (
                supabase.table("essay_sessions")
                .select(
                    "council_config, word_target, topic, so_what_answer, essay_type"
                )
                .eq("id", body.session_id)
                .eq("user_id", user.id)
                .limit(1)
                .execute()
            )
            if session_row.data:
                row = session_row.data[0]
                raw_council_config = row.get("council_config")
                word_target = row.get("word_target")
                session_topic = row.get("topic")
                session_so_what = row.get("so_what_answer")
                session_essay_type = row.get("essay_type")
        except Exception as e:
            print(f"WARN: failed to load session {body.session_id} for council config: {e}")

    if raw_council_config is None:
        try:
            ucc = (
                supabase.table("user_council_config")
                .select("personas, chairman_model")
                .eq("user_id", user.id)
                .limit(1)
                .execute()
            )
            if ucc.data:
                raw_council_config = {
                    "personas": ucc.data[0].get("personas") or [],
                    "chairman_model": ucc.data[0].get("chairman_model"),
                }
        except Exception as e:
            print(f"WARN: failed to load user council config: {e}")

    if raw_council_config is None:
        raw_council_config = factory_council_config()

    council_personas, council_models, chairman_override = resolve_council_config(
        raw_council_config
    )

    # ------------------------------------------------------------------
    # Resolve the invisible voice-library scaffold for this run.
    # If the session already picked one, reuse it (so re-runs of the same
    # session keep the same voice anchor). Otherwise pick at random,
    # seeded by session_id when available so re-runs are deterministic.
    # ------------------------------------------------------------------
    library_voice: Optional[Dict[str, Any]] = None
    library_voice_id: Optional[str] = None
    pinned_voice_id: Optional[str] = None
    if body.session_id:
        try:
            v_row = (
                supabase.table("essay_sessions")
                .select("voice_library_id")
                .eq("id", body.session_id)
                .eq("user_id", user.id)
                .limit(1)
                .execute()
            )
            if v_row.data:
                pinned_voice_id = v_row.data[0].get("voice_library_id")
        except Exception as e:
            print(f"WARN: failed to load voice_library_id for session {body.session_id}: {e}")

    if pinned_voice_id:
        library_voice = get_voice_by_id(pinned_voice_id)
        if library_voice:
            library_voice_id = pinned_voice_id

    if library_voice is None:
        library_voice = pick_random_voice(seed=body.session_id)
        if library_voice:
            library_voice_id = library_voice.get("id")
            # Pin to the session for future re-runs.
            if body.session_id and library_voice_id:
                try:
                    supabase.table("essay_sessions").update(
                        {"voice_library_id": library_voice_id}
                    ).eq("id", body.session_id).eq("user_id", user.id).execute()
                except Exception as e:
                    print(f"WARN: failed to pin voice_library_id on session: {e}")

    async def event_generator():
        try:
            # Initialize variables for metadata
            stage1_results = []
            stage2_results = []
            stage3_result = None
            label_to_model = {}
            aggregate_rankings = {}
            
            # Add user message
            storage.add_user_message(conversation_id, body.content)

            posthog.capture(
                "council_started",
                distinct_id=user.id,
                properties={
                    "execution_mode": body.execution_mode,
                    "essay_mode": body.essay_mode,
                    "web_search_enabled": body.web_search,
                    "is_first_message": is_first_message,
                },
            )

            # Start title generation in parallel (don't await yet)
            title_task = None
            if is_first_message:
                title_task = asyncio.create_task(generate_conversation_title(body.content))

            # Perform web search if requested
            search_context = ""
            search_query = ""
            if body.web_search:
                # Check for disconnect before starting search
                if await request.is_disconnected():
                    print("Client disconnected before web search")
                    raise asyncio.CancelledError("Client disconnected")

                settings = get_settings()
                provider = SearchProvider(settings.search_provider)

                # Set API keys if configured
                if settings.serper_api_key and provider == SearchProvider.SERPER:
                    os.environ["SERPER_API_KEY"] = settings.serper_api_key
                if settings.tavily_api_key and provider == SearchProvider.TAVILY:
                    os.environ["TAVILY_API_KEY"] = settings.tavily_api_key
                if settings.brave_api_key and provider == SearchProvider.BRAVE:
                    os.environ["BRAVE_API_KEY"] = settings.brave_api_key

                yield f"data: {json.dumps({'type': 'search_start', 'data': {'provider': provider.value}})}\n\n"

                # Check for disconnect before generating search query
                if await request.is_disconnected():
                    print("Client disconnected during search setup")
                    raise asyncio.CancelledError("Client disconnected")

                # Generate search query (passthrough - no AI model needed)
                search_query = generate_search_query(body.content)

                # Check for disconnect before performing search
                if await request.is_disconnected():
                    print("Client disconnected before search execution")
                    raise asyncio.CancelledError("Client disconnected")

                # Run search (now fully async for Tavily/Brave, threaded only for DuckDuckGo)
                search_result = await perform_web_search(
                    search_query, 
                    settings.search_result_count,  # Configurable result count (default 8)
                    provider, 
                    settings.full_content_results,
                    settings.search_keyword_extraction,
                    hybrid_mode=settings.search_hybrid_mode  # Combine web+news for DuckDuckGo
                )
                search_context = search_result["results"]
                extracted_query = search_result["extracted_query"]
                search_intent = search_result.get("intent", "unknown")
                yield f"data: {json.dumps({'type': 'search_complete', 'data': {'search_query': search_query, 'extracted_query': extracted_query, 'search_context': search_context, 'provider': provider.value, 'intent': search_intent}})}\n\n"
                posthog.capture(
                    "web_search_performed",
                    distinct_id=user.id,
                    properties={
                        "provider": provider.value,
                        "search_intent": search_intent,
                    },
                )
                await asyncio.sleep(0.05)

            # Stage 1: Collect responses
            yield f"data: {json.dumps({'type': 'stage1_start'})}\n\n"
            await asyncio.sleep(0.05)
            
            total_models = 0
            
            async for item in stage1_collect_responses(
                body.content,
                search_context,
                request,
                essay_mode=body.essay_mode,
                council_models=council_models,
                council_personas=council_personas,
                word_target=word_target,
                user_id=user.id,
                library_voice=library_voice,
            ):
                if isinstance(item, int):
                    total_models = item
                    print(f"DEBUG: Sending stage1_init with total={total_models}")
                    yield f"data: {json.dumps({'type': 'stage1_init', 'total': total_models})}\n\n"
                    continue
                
                stage1_results.append(item)
                yield f"data: {json.dumps({'type': 'stage1_progress', 'data': item, 'count': len(stage1_results), 'total': total_models})}\n\n"
                await asyncio.sleep(0.01)

            yield f"data: {json.dumps({'type': 'stage1_complete', 'data': stage1_results})}\n\n"
            await asyncio.sleep(0.05)

            # Check if any models responded successfully in Stage 1
            if not any(r for r in stage1_results if not r.get('error')):
                error_msg = 'All models failed to respond in Stage 1, likely due to rate limits or API errors. Please try again or adjust your model selection.'
                storage.add_error_message(conversation_id, error_msg)
                posthog.capture(
                    "council_error",
                    distinct_id=user.id,
                    properties={"reason": "all_models_failed", "execution_mode": body.execution_mode},
                )
                yield f"data: {json.dumps({'type': 'error', 'message': error_msg})}\n\n"
                return # Stop further processing

            # Stage 2: Only if mode is 'chat_ranking' or 'full'
            if body.execution_mode in ["chat_ranking", "full"]:
                yield f"data: {json.dumps({'type': 'stage2_start'})}\n\n"
                await asyncio.sleep(0.05)
                
                # Iterate over the async generator
                async for item in stage2_collect_rankings(body.content, stage1_results, search_context, request):
                    # First item is the label mapping
                    if isinstance(item, dict) and not item.get('model'):
                        label_to_model = item
                        # Send init event with total count
                        yield f"data: {json.dumps({'type': 'stage2_init', 'total': len(label_to_model)})}\n\n"
                        continue
                    
                    # Subsequent items are results
                    stage2_results.append(item)
                    
                    # Send progress update
                    print(f"Stage 2 Progress: {len(stage2_results)}/{len(label_to_model)} - {item['model']}")
                    yield f"data: {json.dumps({'type': 'stage2_progress', 'data': item, 'count': len(stage2_results), 'total': len(label_to_model)})}\n\n"
                    await asyncio.sleep(0.01)

                aggregate_rankings = calculate_aggregate_rankings(stage2_results, label_to_model)
                yield f"data: {json.dumps({'type': 'stage2_complete', 'data': stage2_results, 'metadata': {'label_to_model': label_to_model, 'aggregate_rankings': aggregate_rankings, 'search_query': search_query, 'search_context': search_context}})}\n\n"
                await asyncio.sleep(0.05)

            # Stage 3: Only if mode is 'full'
            if body.execution_mode == "full":
                yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
                await asyncio.sleep(0.05)

                # Check for disconnect before starting Stage 3
                if await request.is_disconnected():
                    print("Client disconnected before Stage 3")
                    raise asyncio.CancelledError("Client disconnected")

                stage3_result = await stage3_synthesize_final(
                    body.content,
                    stage1_results,
                    stage2_results,
                    search_context,
                    essay_mode=body.essay_mode,
                    chairman_model_override=chairman_override,
                    word_target=word_target,
                    user_id=user.id,
                    library_voice=library_voice,
                )
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"

            # Wait for title generation if it was started
            if title_task:
                try:
                    title = await title_task
                    storage.update_conversation_title(conversation_id, title)
                    yield f"data: {json.dumps({'type': 'title_complete', 'data': {'title': title}})}\n\n"
                except Exception as e:
                    print(f"Error waiting for title task: {e}")

            # Save complete assistant message with metadata
            metadata = {
                "execution_mode": body.execution_mode,  # Save mode for historical context
                "essay_mode": body.essay_mode,  # Phase 4: topic vs draft
            }
            
            # Only include stage2/stage3 metadata if they were executed
            if body.execution_mode in ["chat_ranking", "full"]:
                metadata["label_to_model"] = label_to_model
                metadata["aggregate_rankings"] = aggregate_rankings
            
            if search_context:
                metadata["search_context"] = search_context
            if search_query:
                metadata["search_query"] = search_query

            storage.add_assistant_message(
                conversation_id,
                stage1_results,
                stage2_results if body.execution_mode in ["chat_ranking", "full"] else None,
                stage3_result if body.execution_mode == "full" else None,
                metadata
            )

            if body.execution_mode == "full" and stage3_result:
                from .essay_memory import derive_topic_from_message, upsert_completed_essay

                fe = stage3_result.get("response")
                if fe is None:
                    fe = stage3_result.get("content")
                if fe is None:
                    fe = ""
                if not isinstance(fe, str):
                    fe = str(fe)
                topic_val = (session_topic or "").strip() or derive_topic_from_message(
                    body.content
                )
                essay_row_id = upsert_completed_essay(
                    user_id=user.id,
                    conversation_id=conversation_id,
                    session_id=body.session_id,
                    essay_mode=body.essay_mode,
                    word_target=word_target,
                    topic=topic_val,
                    full_essay=fe.strip(),
                    essay_type=session_essay_type,
                    so_what_answer=session_so_what,
                )
                posthog.capture(
                    "essay_saved",
                    distinct_id=user.id,
                    properties={
                        "essay_mode": body.essay_mode,
                        "essay_type": session_essay_type or "general",
                        "has_word_target": word_target is not None,
                    },
                )

                # Fire-and-forget: extract durable user facts from this
                # essay so future essays can pull biographical / voice
                # memory into the prompt. Wrapped so any failure is just
                # a log line — never reaches the user-facing stream.
                if fe.strip():
                    from .memory_extraction import extract_and_store

                    async def _run_memory_extraction(
                        uid: str,
                        text: str,
                        topic: str,
                        eid: Optional[str],
                    ) -> None:
                        try:
                            await extract_and_store(
                                user_id=uid,
                                essay_text=text,
                                topic=topic,
                                source_essay_id=eid,
                            )
                        except Exception as ex:
                            print(f"WARN: memory extraction failed: {ex}")

                    asyncio.create_task(
                        _run_memory_extraction(
                            user.id,
                            fe.strip(),
                            topic_val,
                            essay_row_id,
                        )
                    )

            posthog.capture(
                "council_completed",
                distinct_id=user.id,
                properties={
                    "execution_mode": body.execution_mode,
                    "stage1_count": len(stage1_results),
                    "web_search_used": bool(search_context),
                },
            )

            # Send completion event
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except asyncio.CancelledError:
            print(f"Stream cancelled for conversation {conversation_id}")
            # Even if cancelled, try to save the title if it's ready or nearly ready
            if title_task:
                try:
                    # Give it a small grace period to finish if it's close
                    title = await asyncio.wait_for(title_task, timeout=2.0)
                    storage.update_conversation_title(conversation_id, title)
                    print(f"Saved title despite cancellation: {title}")
                except Exception as e:
                    print(f"Could not save title during cancellation: {e}")
            raise
        except Exception as e:
            print(f"Stream error: {e}")
            # Save error to conversation history
            storage.add_error_message(conversation_id, f"Error: {str(e)}")
            # Send error event
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


class UpdateSettingsRequest(BaseModel):
    """Request to update settings."""
    search_provider: Optional[str] = None
    search_keyword_extraction: Optional[str] = None
    ollama_base_url: Optional[str] = None
    full_content_results: Optional[int] = None

    # Custom OpenAI-compatible endpoint
    custom_endpoint_name: Optional[str] = None
    custom_endpoint_url: Optional[str] = None
    custom_endpoint_api_key: Optional[str] = None

    # API Keys
    serper_api_key: Optional[str] = None
    tavily_api_key: Optional[str] = None
    brave_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    google_api_key: Optional[str] = None
    mistral_api_key: Optional[str] = None
    deepseek_api_key: Optional[str] = None
    groq_api_key: Optional[str] = None

    # Enabled Providers
    enabled_providers: Optional[Dict[str, bool]] = None
    direct_provider_toggles: Optional[Dict[str, bool]] = None

    # Council Configuration (unified)
    council_models: Optional[List[str]] = None
    chairman_model: Optional[str] = None
    
    # Remote/Local filters
    council_member_filters: Optional[Dict[int, str]] = None
    chairman_filter: Optional[str] = None
    search_query_filter: Optional[str] = None

    # Temperature Settings
    council_temperature: Optional[float] = None
    chairman_temperature: Optional[float] = None
    stage2_temperature: Optional[float] = None

    # Execution Mode
    execution_mode: Optional[str] = None

    # System Prompts
    stage1_prompt: Optional[str] = None
    stage2_prompt: Optional[str] = None
    stage3_prompt: Optional[str] = None

    # Stage 1 council personas (Phase 1: essay-writing personas)
    # Each entry: {"name": str, "description": str, "prompt": str}
    council_personas: Optional[List[Dict[str, str]]] = None



class TestTavilyRequest(BaseModel):
    """Request to test Tavily API key."""
    api_key: str | None = None


@app.get("/api/settings")
async def get_app_settings():
    """Get current application settings."""
    settings = get_settings()
    return {
        "search_provider": settings.search_provider,
        "search_keyword_extraction": settings.search_keyword_extraction,
        "ollama_base_url": settings.ollama_base_url,
        "full_content_results": settings.full_content_results,

        # Custom Endpoint
        "custom_endpoint_name": settings.custom_endpoint_name,
        "custom_endpoint_url": settings.custom_endpoint_url,
        # Don't send the API key to frontend for security

        # API Key Status
        "serper_api_key_set": bool(settings.serper_api_key),
        "tavily_api_key_set": bool(settings.tavily_api_key),
        "brave_api_key_set": bool(settings.brave_api_key),
        "openrouter_api_key_set": bool(settings.openrouter_api_key),
        "openai_api_key_set": bool(settings.openai_api_key),
        "anthropic_api_key_set": bool(settings.anthropic_api_key),
        "google_api_key_set": bool(settings.google_api_key),
        "mistral_api_key_set": bool(settings.mistral_api_key),
        "deepseek_api_key_set": bool(settings.deepseek_api_key),
        "groq_api_key_set": bool(settings.groq_api_key),
        "custom_endpoint_api_key_set": bool(settings.custom_endpoint_api_key),

        # Enabled Providers
        "enabled_providers": settings.enabled_providers,
        "direct_provider_toggles": settings.direct_provider_toggles,

        # Council Configuration (unified)
        "council_models": settings.council_models,
        "chairman_model": settings.chairman_model,
        
        # Remote/Local filters
        "council_member_filters": settings.council_member_filters,
        "chairman_filter": settings.chairman_filter,
        "search_query_filter": settings.search_query_filter,

        # Temperature Settings
        "council_temperature": settings.council_temperature,
        "chairman_temperature": settings.chairman_temperature,
        "stage2_temperature": settings.stage2_temperature,

        # Prompts
        "stage1_prompt": settings.stage1_prompt,
        "stage2_prompt": settings.stage2_prompt,
        "stage3_prompt": settings.stage3_prompt,

        # Stage 1 council personas
        "council_personas": [p.model_dump() for p in settings.council_personas],
    }



@app.get("/api/settings/defaults")
async def get_default_settings():
    """Get default model settings."""
    from .prompts import (
        STAGE1_PROMPT_DEFAULT,
        STAGE2_PROMPT_DEFAULT,
        STAGE3_PROMPT_DEFAULT,
        TITLE_PROMPT_DEFAULT,
        DEFAULT_COUNCIL_PERSONAS,
    )
    from .settings import DEFAULT_ENABLED_PROVIDERS
    return {
        "council_models": DEFAULT_COUNCIL_MODELS,
        "chairman_model": DEFAULT_CHAIRMAN_MODEL,
        "enabled_providers": DEFAULT_ENABLED_PROVIDERS,
        "stage1_prompt": STAGE1_PROMPT_DEFAULT,
        "stage2_prompt": STAGE2_PROMPT_DEFAULT,
        "stage3_prompt": STAGE3_PROMPT_DEFAULT,
        "council_personas": DEFAULT_COUNCIL_PERSONAS,
    }


@app.put("/api/settings")
async def update_app_settings(request: UpdateSettingsRequest):
    """Update application settings."""
    updates = {}

    if request.search_provider is not None:
        # Validate provider
        try:
            provider = SearchProvider(request.search_provider)
            updates["search_provider"] = provider
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid search provider. Must be one of: {[p.value for p in SearchProvider]}"
            )

    if request.search_keyword_extraction is not None:
        if request.search_keyword_extraction not in ["direct", "yake"]:
             raise HTTPException(
                status_code=400,
                detail="Invalid keyword extraction mode. Must be 'direct' or 'yake'"
            )
        updates["search_keyword_extraction"] = request.search_keyword_extraction

    if request.ollama_base_url is not None:
        updates["ollama_base_url"] = request.ollama_base_url

    # Custom endpoint
    if request.custom_endpoint_name is not None:
        updates["custom_endpoint_name"] = request.custom_endpoint_name
    if request.custom_endpoint_url is not None:
        updates["custom_endpoint_url"] = request.custom_endpoint_url
    if request.custom_endpoint_api_key is not None:
        updates["custom_endpoint_api_key"] = request.custom_endpoint_api_key

    if request.full_content_results is not None:
        # Validate range
        if request.full_content_results < 0 or request.full_content_results > 10:
            raise HTTPException(
                status_code=400,
                detail="full_content_results must be between 0 and 10"
            )
        updates["full_content_results"] = request.full_content_results

    # Prompt updates
    if request.stage1_prompt is not None:
        updates["stage1_prompt"] = request.stage1_prompt
    if request.stage2_prompt is not None:
        updates["stage2_prompt"] = request.stage2_prompt
    if request.stage3_prompt is not None:
        updates["stage3_prompt"] = request.stage3_prompt

    # Stage 1 council personas (Phase 1: essay-writing personas)
    if request.council_personas is not None:
        from .settings import CouncilPersona
        try:
            updates["council_personas"] = [
                CouncilPersona(
                    name=p.get("name", ""),
                    description=p.get("description", ""),
                    prompt=p.get("prompt", ""),
                )
                for p in request.council_personas
            ]
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid council_personas payload: {e}",
            )

    if request.serper_api_key is not None:
        updates["serper_api_key"] = request.serper_api_key
        # Also set in environment for immediate use
        if request.serper_api_key:
            os.environ["SERPER_API_KEY"] = request.serper_api_key

    if request.tavily_api_key is not None:
        updates["tavily_api_key"] = request.tavily_api_key
        # Also set in environment for immediate use
        if request.tavily_api_key:
            os.environ["TAVILY_API_KEY"] = request.tavily_api_key

    if request.brave_api_key is not None:
        updates["brave_api_key"] = request.brave_api_key
        # Also set in environment for immediate use
        if request.brave_api_key:
            os.environ["BRAVE_API_KEY"] = request.brave_api_key

    if request.openrouter_api_key is not None:
        updates["openrouter_api_key"] = request.openrouter_api_key
        
    # Direct Provider Keys
    if request.openai_api_key is not None:
        updates["openai_api_key"] = request.openai_api_key
    if request.anthropic_api_key is not None:
        updates["anthropic_api_key"] = request.anthropic_api_key
    if request.google_api_key is not None:
        updates["google_api_key"] = request.google_api_key
    if request.mistral_api_key is not None:
        updates["mistral_api_key"] = request.mistral_api_key
    if request.deepseek_api_key is not None:
        updates["deepseek_api_key"] = request.deepseek_api_key
    if request.groq_api_key is not None:
        updates["groq_api_key"] = request.groq_api_key

    # Enabled Providers
    if request.enabled_providers is not None:
        updates["enabled_providers"] = request.enabled_providers

    if request.direct_provider_toggles is not None:
        updates["direct_provider_toggles"] = request.direct_provider_toggles

    # Council Configuration (unified)
    if request.council_models is not None:
        # Validate that at least two models are selected
        if len(request.council_models) < 2:
            raise HTTPException(
                status_code=400,
                detail="At least two council models must be selected"
            )
        if len(request.council_models) > 8:
            raise HTTPException(
                status_code=400,
                detail="Maximum of 8 council models allowed"
            )
        updates["council_models"] = request.council_models

    if request.chairman_model is not None:
        updates["chairman_model"] = request.chairman_model
        
    # Remote/Local filters
    if request.council_member_filters is not None:
        updates["council_member_filters"] = request.council_member_filters
    if request.chairman_filter is not None:
        updates["chairman_filter"] = request.chairman_filter
    if request.search_query_filter is not None:
        updates["search_query_filter"] = request.search_query_filter

    # Temperature Settings
    if request.council_temperature is not None:
        updates["council_temperature"] = request.council_temperature
    if request.chairman_temperature is not None:
        updates["chairman_temperature"] = request.chairman_temperature
    if request.stage2_temperature is not None:
        updates["stage2_temperature"] = request.stage2_temperature

    # Prompts   # Execution Mode
    if request.execution_mode is not None:
        valid_modes = ["chat_only", "chat_ranking", "full"]
        if request.execution_mode not in valid_modes:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid execution_mode. Must be one of: {valid_modes}"
            )
        updates["execution_mode"] = request.execution_mode

    if updates:
        settings = update_settings(**updates)
    else:
        settings = get_settings()

    return {
        "search_provider": settings.search_provider,
        "search_keyword_extraction": settings.search_keyword_extraction,
        "ollama_base_url": settings.ollama_base_url,
        "full_content_results": settings.full_content_results,

        # Custom Endpoint
        "custom_endpoint_name": settings.custom_endpoint_name,
        "custom_endpoint_url": settings.custom_endpoint_url,

        # API Key Status
        "serper_api_key_set": bool(settings.serper_api_key),
        "tavily_api_key_set": bool(settings.tavily_api_key),
        "brave_api_key_set": bool(settings.brave_api_key),
        "openrouter_api_key_set": bool(settings.openrouter_api_key),
        "openai_api_key_set": bool(settings.openai_api_key),
        "anthropic_api_key_set": bool(settings.anthropic_api_key),
        "google_api_key_set": bool(settings.google_api_key),
        "mistral_api_key_set": bool(settings.mistral_api_key),
        "deepseek_api_key_set": bool(settings.deepseek_api_key),
        "groq_api_key_set": bool(settings.groq_api_key),
        "custom_endpoint_api_key_set": bool(settings.custom_endpoint_api_key),

        # Enabled Providers
        "enabled_providers": settings.enabled_providers,
        "direct_provider_toggles": settings.direct_provider_toggles,

        # Council Configuration (unified)
        "council_models": settings.council_models,
        "chairman_model": settings.chairman_model,

        # Remote/Local filters
        "council_member_filters": settings.council_member_filters,
        "chairman_filter": settings.chairman_filter,

        # Prompts
        "stage1_prompt": settings.stage1_prompt,
        "stage2_prompt": settings.stage2_prompt,
        "stage3_prompt": settings.stage3_prompt,

        # Stage 1 council personas
        "council_personas": [p.model_dump() for p in settings.council_personas],
    }


# ---------------------------------------------------------------------------
# Voice Profile (per-user, Supabase-backed)
# ---------------------------------------------------------------------------
#
# The voice profile holds:
#   * rules                — user-curated, AI-suggested but user-approved
#   * reference_paragraphs — user's own writing samples
#   * inferred_style       — short LLM summary of their voice
#   * preferred_authors    — names of writers they admire (intake Step 4)
#   * pending_suggestions  — review queue: AI-suggested rules awaiting
#                             accept / reject decisions
#
# Suggested rules NEVER auto-commit. Only `accept-suggestion` moves a
# pending entry into the canonical `rules` list.


@app.get("/api/voice-profile")
async def api_get_voice_profile(
    essay_type: str = "general",
    user: AuthUser = Depends(get_current_user),
):
    profile = load_voice_profile(user.id, essay_type=essay_type)
    return profile.model_dump()


@app.post("/api/voice-profile")
async def api_save_voice_profile(
    body: VoiceProfileSaveBody,
    essay_type: str = "general",
    user: AuthUser = Depends(get_current_user),
):
    """Save user-editable fields. The pending review queue is owned by the
    /api/voice-profile/suggest|accept|reject endpoints and never written
    here."""
    saved = save_voice_profile(user.id, body, essay_type=essay_type)
    posthog.capture(
        "voice_profile_saved",
        distinct_id=user.id,
        properties={"essay_type": essay_type},
    )
    return saved.model_dump()


class SuggestRulesRequest(BaseModel):
    """Body for POST /api/voice-profile/suggest-rules.

    `source` controls what we feed the LLM:
      - 'reference_paragraphs' — the user's own samples (default)
      - 'sample_text'           — a one-shot pasted text in `text`
    """

    source: str = "reference_paragraphs"
    text: Optional[str] = None
    essay_type: str = "general"


@app.post("/api/voice-profile/suggest-rules")
async def api_suggest_rules(
    body: SuggestRulesRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Run a single LLM extraction pass and append candidate rules to the
    user's pending-review queue. Returns the updated profile."""
    profile = load_voice_profile(user.id, essay_type=body.essay_type)
    samples: List[str] = []
    if body.source == "sample_text" and body.text:
        samples = [body.text.strip()]
    else:
        samples = list(profile.reference_paragraphs)

    if not samples:
        raise HTTPException(
            status_code=400,
            detail="No reference paragraphs available. Add a sample first or pass `text`.",
        )

    suggested = await _extract_voice_rules_via_llm(samples)
    updated = add_suggestions(
        user.id,
        suggested.get("rules", []),
        source="reference_paragraphs" if body.source != "sample_text" else "manual",
        essay_type=body.essay_type,
    )

    inferred_style = (suggested.get("inferred_style") or "").strip()
    if inferred_style and not (updated.inferred_style or "").strip():
        updated = save_voice_profile(
            user.id,
            VoiceProfileSaveBody(inferred_style=inferred_style),
            essay_type=body.essay_type,
        )

    return updated.model_dump()


class SuggestionDecisionRequest(BaseModel):
    suggestion_id: str
    essay_type: str = "general"


@app.post("/api/voice-profile/accept-suggestion")
async def api_accept_suggestion(
    body: SuggestionDecisionRequest,
    user: AuthUser = Depends(get_current_user),
):
    return accept_suggestion(
        user.id, body.suggestion_id, essay_type=body.essay_type
    ).model_dump()


@app.post("/api/voice-profile/reject-suggestion")
async def api_reject_suggestion(
    body: SuggestionDecisionRequest,
    user: AuthUser = Depends(get_current_user),
):
    return reject_suggestion(
        user.id, body.suggestion_id, essay_type=body.essay_type
    ).model_dump()


class ProposeRuleFromRefinementBody(BaseModel):
    """Body for POST /api/voice-profile/propose-rule-from-refinement.

    Called from the frontend right after a refinement run completes. We
    distill the user's free-form instruction (e.g. "make the opening less
    flowery, no em-dashes") into ONE durable rule and stage it in the
    pending_suggestions queue. The user accepts or rejects through the
    existing review UI — nothing auto-commits to canonical rules.
    """

    instruction: str = Field(..., min_length=1, max_length=4000)
    essay_type: str = "general"


@app.post("/api/voice-profile/propose-rule-from-refinement")
async def api_propose_rule_from_refinement(
    body: ProposeRuleFromRefinementBody,
    user: AuthUser = Depends(get_current_user),
):
    """Distill a refinement instruction → rule, stage it for the user to accept.

    Returns:
      { proposed: bool, rule: str | None, profile: <VoiceProfile dict> }

    `proposed=False` means the LLM judged the instruction too one-off to
    generalize — UI should silently skip the prompt rather than offer a bad rule.
    """
    from .memory_extraction import distill_refinement_to_rule

    rule = await distill_refinement_to_rule(body.instruction)
    if not rule:
        profile = load_voice_profile(user.id, essay_type=body.essay_type)
        return {"proposed": False, "rule": None, "profile": profile.model_dump()}

    # Don't propose something the user already has as a rule (case-insensitive).
    profile = load_voice_profile(user.id, essay_type=body.essay_type)
    if rule.lower() in {r.lower() for r in profile.rules}:
        return {"proposed": False, "rule": rule, "profile": profile.model_dump()}

    updated = add_suggestions(
        user.id,
        [rule],
        source="manual",
        essay_type=body.essay_type,
    )
    posthog.capture(
        "rule_proposed_from_refinement",
        distinct_id=user.id,
        properties={"essay_type": body.essay_type},
    )
    return {"proposed": True, "rule": rule, "profile": updated.model_dump()}


class EssayMemoryFeedbackBody(BaseModel):
    conversation_id: str = Field(..., min_length=1)
    rating: Optional[int] = Field(None, ge=1, le=5)
    feedback_text: Optional[str] = None


@app.post("/api/essay-memory/feedback")
async def api_essay_memory_feedback(
    body: EssayMemoryFeedbackBody,
    user: AuthUser = Depends(get_current_user),
):
    from .essay_memory import save_essay_feedback

    ok = save_essay_feedback(
        user_id=user.id,
        conversation_id=body.conversation_id.strip(),
        rating=body.rating,
        feedback_text=body.feedback_text,
    )
    if not ok:
        raise HTTPException(
            status_code=404,
            detail="No saved essay found for this conversation yet.",
        )
    return {"ok": True}


class UserFactBody(BaseModel):
    fact_text: str = Field(..., min_length=1, max_length=8000)
    source: Optional[str] = "manual"


@app.post("/api/user-facts")
async def api_create_user_fact(
    body: UserFactBody,
    user: AuthUser = Depends(get_current_user),
):
    from .user_facts import add_user_fact

    row = add_user_fact(user.id, body.fact_text, source=body.source or "manual")
    if not row:
        raise HTTPException(status_code=400, detail="Could not save fact")
    return row


@app.get("/api/user-facts")
async def api_list_user_facts(user: AuthUser = Depends(get_current_user)):
    from .user_facts import list_user_facts

    return {"facts": list_user_facts(user.id)}


@app.delete("/api/user-facts/{fact_id}")
async def api_delete_user_fact(
    fact_id: str,
    user: AuthUser = Depends(get_current_user),
):
    from .user_facts import delete_user_fact

    if not delete_user_fact(user.id, fact_id):
        raise HTTPException(status_code=404, detail="Fact not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Smart intake (Phase: smart-intake)
# ---------------------------------------------------------------------------
#
# Two single-LLM-call helpers used by the new EssayFlow:
#
#   POST /api/intake/questions   — generate 3-5 tailored probing questions
#                                  given (topic, audience). Single call,
#                                  no council.
#   POST /api/intake/core-idea   — given the answers, distill a 1-paragraph
#                                  brief. Single call, no council.


_INTAKE_MODEL = "openrouter:anthropic/claude-sonnet-4"


class IntakeQuestionsRequest(BaseModel):
    topic: str
    audience: str = ""
    essay_type: str = "general"


@app.post("/api/intake/questions")
async def api_intake_questions(
    body: IntakeQuestionsRequest,
    user: AuthUser = Depends(get_current_user),
):
    if not (body.topic or "").strip():
        raise HTTPException(status_code=400, detail="topic is required")
    questions = await _generate_intake_questions(
        topic=body.topic.strip(),
        audience=(body.audience or "").strip(),
        essay_type=(body.essay_type or "general").strip() or "general",
    )
    posthog.capture(
        "intake_started",
        distinct_id=user.id,
        properties={
            "essay_type": (body.essay_type or "general"),
            "has_audience": bool((body.audience or "").strip()),
        },
    )
    return {"questions": questions}


class IntakeExampleRequest(BaseModel):
    topic: str
    audience: str = ""
    question: str


@app.post("/api/intake/example")
async def api_intake_example(
    body: IntakeExampleRequest,
    user: AuthUser = Depends(get_current_user),
):
    if not (body.topic or "").strip():
        raise HTTPException(status_code=400, detail="topic is required")
    if not (body.question or "").strip():
        raise HTTPException(status_code=400, detail="question is required")
    example = await _generate_example_answer(
        topic=body.topic.strip(),
        audience=(body.audience or "").strip(),
        question=body.question.strip(),
    )
    return {"example": example}


class IntakeCoreIdeaRequest(BaseModel):
    topic: str
    audience: str = ""
    essay_type: str = "general"
    qa: List[Dict[str, str]] = []  # [{"question": "...", "answer": "..."}]
    session_id: Optional[str] = None


@app.post("/api/intake/core-idea")
async def api_intake_core_idea(
    body: IntakeCoreIdeaRequest,
    user: AuthUser = Depends(get_current_user),
):
    if not (body.topic or "").strip():
        raise HTTPException(status_code=400, detail="topic is required")
    brief = await _generate_core_idea(
        topic=body.topic.strip(),
        audience=(body.audience or "").strip(),
        qa=body.qa or [],
    )
    if body.session_id and brief:
        try:
            get_supabase().table("essay_sessions").update(
                {
                    "core_idea": brief,
                    "audience": (body.audience or "").strip() or None,
                    "intake_questions": body.qa or [],
                }
            ).eq("id", body.session_id).eq("user_id", user.id).execute()
        except Exception as e:
            print(f"WARN: persist core_idea failed: {e}")
    return {"core_idea": brief}


class RefinementSuggestionsRequest(BaseModel):
    essay_text: str
    original_brief: str = ""


@app.post("/api/refinement-suggestions")
async def api_refinement_suggestions(
    body: RefinementSuggestionsRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Single LLM call: essay-specific refinement chips for the dock."""
    if not (body.essay_text or "").strip():
        raise HTTPException(status_code=400, detail="essay_text is required")
    suggestions = await _generate_refinement_suggestions(
        essay_text=body.essay_text.strip(),
        original_brief=(body.original_brief or "").strip(),
    )
    posthog.capture(
        "refinement_suggestions",
        distinct_id=user.id,
        properties={"count": len(suggestions)},
    )
    return {"suggestions": suggestions}


@app.get("/api/models/direct")
async def get_direct_models():
    """Get available models from all configured direct providers."""
    all_models = []
    
    # Iterate over all providers
    for provider_id, provider in PROVIDERS.items():
        # Skip OpenRouter and Ollama as they are handled separately
        if provider_id in ["openrouter", "ollama", "hybrid"]:
            continue
            
        try:
            # Fetch models from provider
            models = await provider.get_models()
            all_models.extend(models)
        except Exception as e:
            print(f"Error fetching models for {provider_id}: {e}")
            
    return all_models


@app.post("/api/settings/test-tavily")
async def test_tavily_api(request: TestTavilyRequest):
    """Test Tavily API key with a simple search."""
    import httpx
    settings = get_settings()

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": request.api_key or settings.tavily_api_key,
                    "query": "test",
                    "max_results": 1,
                    "search_depth": "basic",
                },
            )

            if response.status_code == 200:
                return {"success": True, "message": "API key is valid"}
            elif response.status_code == 401:
                return {"success": False, "message": "Invalid API key"}
            else:
                return {"success": False, "message": f"API error: {response.status_code}"}

    except httpx.TimeoutException:
        return {"success": False, "message": "Request timed out"}
    except Exception as e:
        return {"success": False, "message": str(e)}


class TestBraveRequest(BaseModel):
    """Request to test Brave API key."""
    api_key: str | None = None


@app.post("/api/settings/test-brave")
async def test_brave_api(request: TestBraveRequest):
    """Test Brave API key with a simple search."""
    import httpx
    settings = get_settings()

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://api.search.brave.com/res/v1/web/search",
                params={"q": "test", "count": 1},
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip",
                    "X-Subscription-Token": request.api_key or settings.brave_api_key,
                },
            )

            if response.status_code == 200:
                return {"success": True, "message": "API key is valid"}
            elif response.status_code == 401 or response.status_code == 403:
                return {"success": False, "message": "Invalid API key"}
            else:
                return {"success": False, "message": f"API error: {response.status_code}"}

    except httpx.TimeoutException:
        return {"success": False, "message": "Request timed out"}
    except Exception as e:
        return {"success": False, "message": str(e)}


class TestSerperRequest(BaseModel):
    """Request to test Serper API key."""
    api_key: str | None = None


@app.post("/api/settings/test-serper")
async def test_serper_api(request: TestSerperRequest):
    """Test Serper API key with a simple search."""
    import httpx
    settings = get_settings()

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                "https://google.serper.dev/search",
                json={"q": "test", "num": 1},
                headers={
                    "X-API-KEY": request.api_key or settings.serper_api_key,
                    "Content-Type": "application/json",
                },
            )

            if response.status_code == 200:
                return {"success": True, "message": "API key is valid"}
            elif response.status_code == 401 or response.status_code == 403:
                return {"success": False, "message": "Invalid API key"}
            else:
                return {"success": False, "message": f"API error: {response.status_code}"}

    except httpx.TimeoutException:
        return {"success": False, "message": "Request timed out"}
    except Exception as e:
        return {"success": False, "message": str(e)}


class TestOpenRouterRequest(BaseModel):
    """Request to test OpenRouter API key."""
    api_key: Optional[str] = None


class TestProviderRequest(BaseModel):
    """Request to test a specific provider's API key."""
    provider_id: str
    api_key: str


@app.post("/api/settings/test-provider")
async def test_provider_api(request: TestProviderRequest):
    """Test an API key for a specific provider."""
    from .council import PROVIDERS
    from .settings import get_settings
    
    if request.provider_id not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid provider ID")
        
    api_key = request.api_key
    if not api_key:
        # Try to get from settings
        settings = get_settings()
        # Map provider_id to setting key (e.g. 'openai' -> 'openai_api_key')
        setting_key = f"{request.provider_id}_api_key"
        if hasattr(settings, setting_key):
             api_key = getattr(settings, setting_key)
    
    if not api_key:
         return {"success": False, "message": "No API key provided or configured"}

    provider = PROVIDERS[request.provider_id]
    return await provider.validate_key(api_key)


class TestOllamaRequest(BaseModel):
    """Request to test Ollama connection."""
    base_url: str


@app.get("/api/ollama/tags")
async def get_ollama_tags(base_url: Optional[str] = None):
    """Fetch available models from Ollama."""
    import httpx
    from .config import get_ollama_base_url
    
    if not base_url:
        base_url = get_ollama_base_url()
        
    if base_url.endswith('/'):
        base_url = base_url[:-1]
        
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{base_url}/api/tags")
            
            if response.status_code != 200:
                return {"models": [], "error": f"Ollama API error: {response.status_code}"}
                
            data = response.json()
            models = []
            for model in data.get("models", []):
                models.append({
                    "id": model.get("name"),
                    "name": model.get("name"),
                    # Ollama doesn't return context length in tags
                    "context_length": None,
                    "is_free": True,
                    "modified_at": model.get("modified_at")
                })
                
            # Sort by modified_at (newest first), fallback to name
            models.sort(key=lambda x: x.get("modified_at", ""), reverse=True)
            return {"models": models}
            
    except httpx.ConnectError:
        return {"models": [], "error": "Could not connect to Ollama. Is it running?"}
    except Exception as e:
        return {"models": [], "error": str(e)}


@app.post("/api/settings/test-ollama")
async def test_ollama_connection(request: TestOllamaRequest):
    """Test connection to Ollama instance."""
    import httpx
    
    base_url = request.base_url
    if base_url.endswith('/'):
        base_url = base_url[:-1]
        
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/api/tags")
            
            if response.status_code == 200:
                return {"success": True, "message": "Successfully connected to Ollama"}
            else:
                return {"success": False, "message": f"Ollama API error: {response.status_code}"}
                
    except httpx.ConnectError:
        return {"success": False, "message": "Could not connect to Ollama. Is it running at this URL?"}
    except Exception as e:
        return {"success": False, "message": str(e)}


class TestCustomEndpointRequest(BaseModel):
    """Request to test custom OpenAI-compatible endpoint."""
    name: str
    url: str
    api_key: Optional[str] = None


@app.post("/api/settings/test-custom-endpoint")
async def test_custom_endpoint(request: TestCustomEndpointRequest):
    """Test connection to a custom OpenAI-compatible endpoint."""
    from .providers.custom_openai import CustomOpenAIProvider

    provider = CustomOpenAIProvider()
    return await provider.validate_connection(request.url, request.api_key or "")


@app.get("/api/custom-endpoint/models")
async def get_custom_endpoint_models():
    """Fetch available models from the custom endpoint."""
    from .providers.custom_openai import CustomOpenAIProvider
    from .settings import get_settings

    settings = get_settings()
    if not settings.custom_endpoint_url:
        return {"models": [], "error": "No custom endpoint configured"}

    provider = CustomOpenAIProvider()
    models = await provider.get_models()
    return {"models": models}


@app.get("/api/models")
async def get_openrouter_models():
    """Fetch available models from OpenRouter API."""
    import httpx
    from .config import get_openrouter_api_key

    api_key = get_openrouter_api_key()
    if not api_key:
        return {"models": [], "error": "No OpenRouter API key configured"}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://openrouter.ai/api/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )

            if response.status_code != 200:
                return {"models": [], "error": f"API error: {response.status_code}"}

            data = response.json()
            models = []
            
            # Comprehensive exclusion list for non-text/chat models
            excluded_terms = [
                "embed", "audio", "whisper", "tts", "dall-e", "realtime", 
                "vision-only", "voxtral", "speech", "transcribe", "sora"
            ]

            for model in data.get("data", []):
                mid = model.get("id", "").lower()
                name_lower = model.get("name", "").lower()
                
                if any(term in mid for term in excluded_terms) or any(term in name_lower for term in excluded_terms):
                    continue

                # Extract pricing - free models have 0 cost
                pricing = model.get("pricing", {})
                prompt_price = float(pricing.get("prompt", "0") or "0")
                completion_price = float(pricing.get("completion", "0") or "0")
                is_free = prompt_price == 0 and completion_price == 0

                models.append({
                    "id": f"openrouter:{model.get('id')}",
                    "name": f"{model.get('name', model.get('id'))} [OpenRouter]",
                    "provider": "OpenRouter",
                    "context_length": model.get("context_length"),
                    "is_free": is_free,
                })

            # Sort by name
            models.sort(key=lambda x: x["name"].lower())
            return {"models": models}

    except httpx.TimeoutException:
        return {"models": [], "error": "Request timed out"}
    except Exception as e:
        return {"models": [], "error": str(e)}


@app.post("/api/settings/test-openrouter")
async def test_openrouter_api(request: TestOpenRouterRequest):
    """Test OpenRouter API key with a simple request."""
    import httpx
    from .config import get_openrouter_api_key

    # Use provided key or fall back to saved key
    api_key = request.api_key if request.api_key else get_openrouter_api_key()
    
    if not api_key:
        return {"success": False, "message": "No API key provided or configured"}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://openrouter.ai/api/v1/models",
                headers={
                    "Authorization": f"Bearer {api_key}",
                },
            )

            if response.status_code == 200:
                return {"success": True, "message": "API key is valid"}
            elif response.status_code == 401:
                return {"success": False, "message": "Invalid API key"}
            else:
                return {"success": False, "message": f"API error: {response.status_code}"}

    except httpx.TimeoutException:
        return {"success": False, "message": "Request timed out"}
    except Exception as e:
        return {"success": False, "message": str(e)}


if __name__ == "__main__":
    import uvicorn
    # Render (and most PaaS) inject the listening port via $PORT. Fall back to
    # 8001 for local dev where nothing sets it.
    port = int(os.environ.get("PORT", "8001"))
    uvicorn.run(app, host="0.0.0.0", port=port)
