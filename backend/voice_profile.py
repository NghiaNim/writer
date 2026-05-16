"""Voice profile storage and prompt-block rendering.

The voice profile is the user's personal style: rules they've curated,
reference paragraphs of their own writing, an inferred-style summary,
plus a "review queue" of AI-suggested rules awaiting accept/reject and
a list of authors they admire.

Persisted to Supabase `public.voice_profiles` (one row per
`(user_id, essay_type)`). Migrated from the file-backed implementation
in 003_voice_library_and_review_queue.

Injection: rendered into the Voice Guardian's Stage 1 prompt and the
Chairman's Stage 3 synthesis prompt via the `{voice_profile_block}`
template variable.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)


DEFAULT_ESSAY_TYPE = "general"


# ---------------------------------------------------------------------------
# Default voice rules
# ---------------------------------------------------------------------------
#
# Every new user is seeded with this list on their first profile read so the
# council has a strong "no AI tells" baseline from minute one. Users can edit,
# remove, or replace any of these — the list is just the starting point.
#
# Grouping is for the prompt block; the underlying `rules` column is a flat
# JSONB array of strings.

DEFAULT_VOICE_RULES: List[str] = [
    # Punctuation and typography
    "Avoid em dashes entirely. Replace with commas, parentheses, periods, or colons depending on function — em dashes are the single strongest AI tell.",
    "Avoid the rhetorical colon followed by a noun phrase (\"The result: chaos.\" / \"The takeaway: simplicity wins.\"). Use full sentences instead.",
    "Don't use semicolons to stitch together balanced clauses for rhythm. Humans use them sparingly; AI overuses them.",
    "Avoid scare quotes around ordinary words (the so-called \"solution\"). Commit to the word or pick a different one.",
    "Don't bold random phrases mid-paragraph for emphasis. If something matters, the sentence should carry the weight.",

    # Sentence structures to ban or limit
    "Cut the negation-affirmation flip entirely: \"It's not X. It's Y.\" / \"This isn't just A, it's B.\"",
    "Don't default to tricolons as a closer (\"fast, elegant, and powerful\"). Vary to two or four items, or break the pattern.",
    "Delete the preambles: \"It's worth noting that…\", \"It's important to remember…\", \"Keep in mind that…\" Just make the point.",
    "Cut the \"From X to Y\" sweep (\"From beginners to experts, everyone benefits\"). Almost always vacuous.",
    "Cut participial wind-ups as transitions (\"Having considered the options, the decision was clear\").",
    "Don't default to the \"While X, Y\" concession opener (\"While the technology is promising, challenges remain\"). Useful occasionally; not as a default hedge.",
    "Avoid rhetorical contrast structures and mirrored sentence patterns. Do not use formulations like \"It was not X. It was Y,\" \"X hadn't happened because Y,\" or short declarative reversals. Vary sentence structure and avoid dramatic realizations or rhythmic parallelism.",

    # Vocabulary to avoid
    "Avoid words that flag AI: delve, navigate (figurative), leverage, robust, seamless, holistic, multifaceted, nuanced, intricate, tapestry, landscape (figurative), realm, journey (figurative), underscore, foster, harness, pivotal, crucial, essential, vital, paramount.",
    "Cut these phrases: \"in today's fast-paced world\", \"in the ever-evolving landscape of\", \"at the heart of\", \"plays a key role in\", \"stands as a testament to\", \"speaks volumes\", \"a double-edged sword\", \"the elephant in the room\".",
    "Don't stack hedges (\"perhaps,\" \"arguably,\" \"in some sense,\" \"to a certain extent,\" \"in many ways\"). Pick one or commit to the claim.",

    # Structural patterns
    "Don't end every paragraph with a summary sentence restating its point. Let ideas land and move on.",
    "Don't open with a question you then answer (\"What makes a great essay? Three things.\"). Acceptable once; AI does it constantly.",
    "Avoid the \"ultimately / in conclusion / in essence\" wrap-up at the end of sections.",
    "Don't begin with a sweeping universal claim (\"Throughout human history…\", \"Since the dawn of…\"). Start in a specific place.",
    "Don't write paragraphs of uniform length. Vary deliberately, including one- or two-sentence paragraphs.",
    "Avoid the \"zero-to-hero\" growth pattern. Do not jump directly from recognizing a problem to complete transformation. Show gradual, believable development through failed attempts, partial progress, reflection, and concrete intermediate steps. Growth should feel incremental, not instantaneous.",
    "Don't repeat a sentence-opening phrase across the essay. If \"I feel like\" appears once, the next sentence that wants it should restructure. Same for \"I realized,\" \"I started to,\" \"What I learned was,\" \"The thing is,\" and any other recurring stem — vary the entry into each sentence so the prose doesn't acquire a rhythmic tic.",

    # Tone and voice
    "No false balance as a default move. If you have a view, state it. Don't \"on the one hand / on the other hand\" everything to seem neutral.",
    "No throat-clearing acknowledgment of the topic's complexity (\"This is a complex issue with many perspectives…\"). Just engage with it.",
    "Avoid the warm-but-empty closer (\"By embracing these principles, we build a better future together\"). Cut the inspirational tail entirely.",
    "Choose specifics over abstractions. If you write \"various challenges,\" name two. If you write \"stakeholders,\" name them.",

    # Positive rules (do this instead)
    "Use concrete nouns and verbs. Replace \"utilize\" with \"use,\" \"facilitate\" with \"help\" or a specific verb, \"implement\" with \"build\" or \"do.\"",
    "Allow uneven sentence lengths. Short. Then a longer one that breathes a bit and carries more weight. Then medium.",
    "Quote specific things, name specific people, cite specific numbers. AI defaults to generality.",
    "Let the essay have an actual argument with a stake, not just an \"exploration.\"",
    "End where the thought ends, not with a coda.",
]


# Columns introduced by migration 003. Pre-migration, an upsert that
# includes them fails with PGRST204 ("column not found in schema cache").
# The helpers below auto-strip these on the first such failure so the UI
# keeps working while the operator applies the migration.
_OPTIONAL_COLUMNS = ("preferred_authors", "pending_suggestions")
_missing_columns_cache: set[str] = set()


def _is_missing_column_error(err: Exception) -> Optional[str]:
    """Return the missing column name if `err` looks like PGRST204, else None."""
    msg = str(err)
    if "schema cache" not in msg and "PGRST204" not in msg and "PGRST205" not in msg:
        return None
    for col in _OPTIONAL_COLUMNS:
        if f"'{col}'" in msg or f'"{col}"' in msg:
            return col
    return None


def _strip_known_missing(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Drop columns we've previously discovered are missing from the schema."""
    if not _missing_columns_cache:
        return payload
    return {k: v for k, v in payload.items() if k not in _missing_columns_cache}


def _safe_upsert(table: str, payload: Dict[str, Any], on_conflict: str) -> None:
    """Upsert, retrying once after stripping any column the schema doesn't have.

    Caches missing-column names process-wide so subsequent calls skip the
    extra round-trip. Falls through any non-schema error to the caller.
    """
    sb = get_supabase()
    payload = _strip_known_missing(payload)
    try:
        sb.table(table).upsert(payload, on_conflict=on_conflict).execute()
        return
    except Exception as e:
        col = _is_missing_column_error(e)
        if not col:
            raise
        logger.warning(
            "voice_profiles: column %r not in schema (migration 003 not applied?); "
            "stripping and retrying. Apply supabase/migrations/003_*.sql to enable it.",
            col,
        )
        _missing_columns_cache.add(col)
        retried = _strip_known_missing(payload)
        if retried.keys() == payload.keys():
            # Nothing was stripped (column wasn't in this payload); the error
            # is unrelated to our optional columns.
            raise
        sb.table(table).upsert(retried, on_conflict=on_conflict).execute()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class PendingRuleSuggestion(BaseModel):
    """A candidate rule awaiting the user's accept/reject in the review queue."""

    id: str
    rule: str
    source: str = "user"  # one of: reference_paragraphs, library_voice, user, manual
    created_at: Optional[str] = None


class VoiceProfile(BaseModel):
    """User-defined writing voice."""

    rules: List[str] = Field(default_factory=list)
    reference_paragraphs: List[str] = Field(default_factory=list)
    inferred_style: str = ""
    pending_suggestions: List[PendingRuleSuggestion] = Field(default_factory=list)
    preferred_authors: List[str] = Field(default_factory=list)


# Body shape for the public POST /voice-profile endpoint. Server controls
# pending_suggestions (via the dedicated review-queue endpoints) so we
# accept only the user-editable fields here.
class VoiceProfileSaveBody(BaseModel):
    rules: Optional[List[str]] = None
    reference_paragraphs: Optional[List[str]] = None
    inferred_style: Optional[str] = None
    preferred_authors: Optional[List[str]] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _strip_list(items: Optional[List[str]]) -> List[str]:
    if not items:
        return []
    return [s.strip() for s in items if s and s.strip()]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_profile(row: Optional[Dict[str, Any]]) -> VoiceProfile:
    if not row:
        return VoiceProfile()
    return VoiceProfile(
        rules=row.get("rules") or [],
        reference_paragraphs=row.get("reference_paragraphs") or [],
        inferred_style=row.get("inferred_style") or "",
        pending_suggestions=[
            PendingRuleSuggestion(**s) if isinstance(s, dict) else PendingRuleSuggestion(id=str(uuid.uuid4()), rule=str(s))
            for s in (row.get("pending_suggestions") or [])
        ],
        preferred_authors=row.get("preferred_authors") or [],
    )


# ---------------------------------------------------------------------------
# Supabase I/O
# ---------------------------------------------------------------------------


def load_voice_profile(
    user_id: str, essay_type: str = DEFAULT_ESSAY_TYPE
) -> VoiceProfile:
    """Fetch the (user_id, essay_type) profile.

    Seed-on-first-read: if no row exists for this user + essay_type yet, we
    insert one preloaded with DEFAULT_VOICE_RULES and return it. From that
    moment on, the row is theirs to edit — emptying the rules list later
    does NOT trigger another reseed, because the row still exists.
    """
    sb = get_supabase()
    try:
        res = (
            sb.table("voice_profiles")
            .select("*")
            .eq("user_id", user_id)
            .eq("essay_type", essay_type)
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.warning("voice_profiles fetch failed for user=%s: %s", user_id, e)
        return VoiceProfile()

    rows = res.data or []
    if rows:
        return _row_to_profile(rows[0])

    # First read for this user — seed with the default rules.
    seed_payload = {
        "user_id": user_id,
        "essay_type": essay_type,
        "rules": list(DEFAULT_VOICE_RULES),
    }
    try:
        ins = sb.table("voice_profiles").insert(seed_payload).execute()
        if ins.data:
            logger.info(
                "voice_profiles: seeded %d default rules for user=%s essay_type=%s",
                len(DEFAULT_VOICE_RULES),
                user_id,
                essay_type,
            )
            return _row_to_profile(ins.data[0])
    except Exception as e:
        # Another concurrent request may have already inserted the row, or
        # the table doesn't exist yet — either way, return the in-memory
        # defaults so the user still gets the protection on this request.
        logger.warning("voice_profiles seed insert failed for %s: %s", user_id, e)

    return VoiceProfile(rules=list(DEFAULT_VOICE_RULES))


def save_voice_profile(
    user_id: str,
    body: VoiceProfileSaveBody,
    essay_type: str = DEFAULT_ESSAY_TYPE,
) -> VoiceProfile:
    """Upsert the user-editable fields of the profile, return the merged result.

    `pending_suggestions` is owned by the review-queue endpoints — this
    function never reads or writes it. That keeps the public POST
    endpoint a stable shape: rules / reference_paragraphs / inferred_style
    / preferred_authors only.
    """
    # Trigger seed-on-first-read BEFORE our upsert so the row exists with
    # DEFAULT_VOICE_RULES populated. Without this, the EssayFlow voice step
    # — which saves only `preferred_authors` — would INSERT a fresh row
    # whose `rules` defaulted to '[]'::jsonb (per migration 001), leaving
    # the user with an empty voice profile even though they never opted out
    # of any defaults.
    load_voice_profile(user_id, essay_type)

    sb = get_supabase()
    update: Dict[str, Any] = {}
    if body.rules is not None:
        update["rules"] = _strip_list(body.rules)
    if body.reference_paragraphs is not None:
        update["reference_paragraphs"] = _strip_list(body.reference_paragraphs)
    if body.inferred_style is not None:
        update["inferred_style"] = (body.inferred_style or "").strip()
    if body.preferred_authors is not None:
        update["preferred_authors"] = _strip_list(body.preferred_authors)

    # Upsert. Supabase's on_conflict relies on the UNIQUE(user_id, essay_type)
    # constraint we added in 001_initial.sql.
    payload = {"user_id": user_id, "essay_type": essay_type, **update}
    try:
        _safe_upsert("voice_profiles", payload, on_conflict="user_id,essay_type")
    except Exception as e:
        logger.error("voice_profiles upsert failed: %s", e)
        raise
    return load_voice_profile(user_id, essay_type)


# ---------- Review-queue helpers (pending_suggestions) ---------------------


def add_suggestions(
    user_id: str,
    rules: List[str],
    source: str,
    essay_type: str = DEFAULT_ESSAY_TYPE,
) -> VoiceProfile:
    """Append AI-suggested rules to the review queue.

    Source is the human-readable origin: one of
    `reference_paragraphs`, `library_voice`, `manual`.
    """
    cleaned = _strip_list(rules)
    if not cleaned:
        return load_voice_profile(user_id, essay_type)

    profile = load_voice_profile(user_id, essay_type)
    # De-dup against current rules and existing suggestions (case-insensitive).
    existing = {r.lower() for r in profile.rules}
    existing.update(s.rule.lower() for s in profile.pending_suggestions)

    new_suggestions: List[Dict[str, Any]] = [
        {
            "id": str(uuid.uuid4()),
            "rule": r,
            "source": source,
            "created_at": _now_iso(),
        }
        for r in cleaned
        if r.lower() not in existing
    ]
    if not new_suggestions:
        return profile

    merged = [s.model_dump() for s in profile.pending_suggestions] + new_suggestions
    _safe_upsert(
        "voice_profiles",
        {
            "user_id": user_id,
            "essay_type": essay_type,
            "pending_suggestions": merged,
        },
        on_conflict="user_id,essay_type",
    )
    return load_voice_profile(user_id, essay_type)


def accept_suggestion(
    user_id: str, suggestion_id: str, essay_type: str = DEFAULT_ESSAY_TYPE
) -> VoiceProfile:
    """Move a pending suggestion into the canonical rules list."""
    profile = load_voice_profile(user_id, essay_type)
    target = next(
        (s for s in profile.pending_suggestions if s.id == suggestion_id), None
    )
    if not target:
        return profile

    new_rules = list(profile.rules)
    if target.rule.lower() not in {r.lower() for r in new_rules}:
        new_rules.append(target.rule)
    new_pending = [s for s in profile.pending_suggestions if s.id != suggestion_id]

    _safe_upsert(
        "voice_profiles",
        {
            "user_id": user_id,
            "essay_type": essay_type,
            "rules": new_rules,
            "pending_suggestions": [s.model_dump() for s in new_pending],
        },
        on_conflict="user_id,essay_type",
    )
    return load_voice_profile(user_id, essay_type)


def reject_suggestion(
    user_id: str, suggestion_id: str, essay_type: str = DEFAULT_ESSAY_TYPE
) -> VoiceProfile:
    """Drop a pending suggestion from the queue without promoting it."""
    profile = load_voice_profile(user_id, essay_type)
    new_pending = [s for s in profile.pending_suggestions if s.id != suggestion_id]
    if len(new_pending) == len(profile.pending_suggestions):
        return profile

    _safe_upsert(
        "voice_profiles",
        {
            "user_id": user_id,
            "essay_type": essay_type,
            "pending_suggestions": [s.model_dump() for s in new_pending],
        },
        on_conflict="user_id,essay_type",
    )
    return load_voice_profile(user_id, essay_type)


# ---------------------------------------------------------------------------
# Prompt-block rendering
# ---------------------------------------------------------------------------


def has_content(profile: VoiceProfile) -> bool:
    return bool(
        profile.rules
        or profile.reference_paragraphs
        or (profile.inferred_style and profile.inferred_style.strip())
        or profile.preferred_authors
    )


def format_voice_profile_block(profile: Optional[VoiceProfile] = None) -> str:
    """Render the profile as a prompt-friendly block.

    Returns empty string when the profile has no content. The block omits
    `pending_suggestions` — those are unaccepted and therefore not part of
    the user's canonical voice yet.
    """
    if profile is None or not has_content(profile):
        return ""

    sections = [
        "USER VOICE PROFILE:",
        "The user has provided the following style guidance. Apply every rule below in the essay you produce. The user's voice rules take precedence over your own stylistic preferences.",
    ]

    if profile.rules:
        sections.append("")
        sections.append("Rules:")
        for rule in profile.rules:
            sections.append(f"- {rule}")

    if profile.preferred_authors:
        sections.append("")
        sections.append(
            "Authors / writers the user admires (lean toward this stylistic register without quoting or naming them in the essay):"
        )
        for a in profile.preferred_authors:
            sections.append(f"- {a}")

    if profile.reference_paragraphs:
        sections.append("")
        sections.append(
            "Reference paragraphs (samples of the user's authentic voice — match the cadence, vocabulary, and rhythm; do not imitate the topic):"
        )
        for i, para in enumerate(profile.reference_paragraphs, start=1):
            sections.append("")
            sections.append(f"[Sample {i}]")
            sections.append(para)

    inferred = (profile.inferred_style or "").strip()
    if inferred:
        sections.append("")
        sections.append("Inferred style notes:")
        sections.append(inferred)

    sections.append("")
    return "\n".join(sections)
