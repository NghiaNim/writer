"""Auto-extract user facts from completed essays.

A single Gemini Flash call reads the finished essay and returns a small
JSON list of categorized facts about the writer. Facts are persisted to
`user_fact` (linked back to the essay row) so future essays can pull
relevant biographical/voice memory into the prompt.

The extractor is deliberately conservative:
  * Skips anything that's not clearly *about the writer* (no
    third-person descriptions, no general claims).
  * Caps at MAX_FACTS_PER_ESSAY so a single essay can't flood memory.
  * Each fact is a self-contained sentence in the third person — no
    "I" pronouns — so it reads cleanly when injected into a future
    prompt block.

Failure mode: any exception is logged and swallowed. Memory extraction
is a fire-and-forget enhancement; an essay completing without it is
strictly better than the user seeing an error.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Optional

from .user_facts import (
    VALID_CATEGORIES,
    bulk_insert_user_facts,
    delete_facts_for_essay,
)

logger = logging.getLogger(__name__)

# Gemini 2.5 Flash — fast, cheap, and reliable for short-JSON tasks. The
# `google:` prefix routes through the existing GoogleProvider, which now
# falls back to the GEMINI_API_KEY env var if no key is saved in settings.
EXTRACTION_MODEL = "google:gemini-2.5-flash"

# Hard caps so a single essay can't flood the memory store.
MAX_FACTS_PER_ESSAY = 8
MAX_FACT_LENGTH = 280
MAX_ESSAY_INPUT_CHARS = 16_000

_SYSTEM_PROMPT = """You are extracting durable memory facts about an essay writer.

You will read an essay the writer just finished and return a short JSON list of facts about THE WRITER (the first-person author of the essay), so a future writing assistant can remember who they are and tailor advice.

WHAT COUNTS AS A FACT:
  - Things the writer has done, lived through, or experienced
  - Places, schools, jobs, communities they belong to
  - People who matter to them (mentors, family, friends — by role, not full names unless the essay names them)
  - Beliefs, values, opinions they hold
  - Subjects, fields, or activities they care about
  - Achievements or milestones they mention
  - Writers, books, films, or works they cite admiringly
  - Voice/style observations the future model should know (e.g. "Tends to write in long, comma-spliced sentences")

WHAT DOES NOT COUNT — DO NOT EMIT:
  - The essay's argument or claims about the world
  - Generic statements that could be true of anyone
  - Anything you're not confident is about the writer (don't guess)
  - Repetition of facts already obvious from the topic line

FORMAT RULES (strict):
  - Return between 0 and 8 facts. If the essay has no clear personal facts, return [].
  - Each fact is a single self-contained sentence, third-person ("Spent two summers ...", "Believes that ...", "Admires ...").
  - DO NOT use "I", "me", "my".
  - Keep each fact under 30 words.
  - Categorize each fact as exactly one of:
      biography     — origin, school, family, residence, job
      experience    — things they've done or lived through
      belief        — values, opinions, what they argue for
      interest      — subjects/fields they care about
      achievement   — awards, accomplishments, milestones
      relationship  — people who matter to them
      reference     — writers/works they admire or cite
      general       — important but doesn't fit the above

OUTPUT — strict JSON, no markdown fences, no commentary:
{"facts": [{"category": "biography", "fact_text": "..."}, ...]}"""


def _build_user_prompt(essay_text: str, topic: Optional[str]) -> str:
    topic_line = f"TOPIC: {topic.strip()}\n\n" if topic and topic.strip() else ""
    return (
        f"{topic_line}ESSAY:\n{essay_text}\n\n"
        "Extract up to 8 durable memory facts about the writer. "
        "Return the strict JSON object specified."
    )


def _truncate_essay(text: str) -> str:
    if not text:
        return ""
    if len(text) <= MAX_ESSAY_INPUT_CHARS:
        return text
    return text[:MAX_ESSAY_INPUT_CHARS] + "\n\n[... truncated for extraction ...]"


def _parse_facts(content: str) -> List[Dict[str, str]]:
    """Pull a list of {category, fact_text} dicts out of an LLM response."""
    if not content:
        return []
    raw = content.strip()

    # Try direct parse, then fall back to extracting the first JSON object.
    parsed: Optional[Dict[str, Any]] = None
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
        return []
    items = parsed.get("facts")
    if not isinstance(items, list):
        return []

    out: List[Dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        cat = str(item.get("category") or "general").strip().lower()
        if cat not in VALID_CATEGORIES:
            cat = "general"
        text = str(item.get("fact_text") or "").strip()
        if not text or len(text) > MAX_FACT_LENGTH:
            continue
        # Strip a trailing period-period or stray quotes so storage stays clean.
        text = text.strip().strip('"').strip()
        if not text:
            continue
        out.append({"category": cat, "fact_text": text})
        if len(out) >= MAX_FACTS_PER_ESSAY:
            break
    return out


async def extract_facts_from_essay(
    essay_text: str, topic: Optional[str] = None
) -> List[Dict[str, str]]:
    """Single Gemini Flash call. Returns [] on any failure."""
    essay = (essay_text or "").strip()
    if len(essay) < 200:
        # Not enough text to learn anything durable.
        return []
    essay = _truncate_essay(essay)

    # Lazy import to avoid a circular import at module load
    # (council.py imports from user_facts at the top level).
    from .council import query_model

    try:
        res = await query_model(
            EXTRACTION_MODEL,
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": _build_user_prompt(essay, topic)},
            ],
            timeout=45.0,
            temperature=0.2,
        )
    except Exception as e:
        logger.warning("memory extraction call failed: %s", e)
        return []

    if not res or res.get("error"):
        if res:
            logger.warning(
                "memory extraction error: %s", res.get("error_message") or res
            )
        return []

    return _parse_facts(res.get("content") or "")


async def extract_and_store(
    *,
    user_id: str,
    essay_text: str,
    topic: Optional[str],
    source_essay_id: Optional[str],
) -> int:
    """Extract facts and persist them. Returns count inserted."""
    if not user_id or not (essay_text or "").strip():
        return 0
    facts = await extract_facts_from_essay(essay_text, topic)
    if not facts:
        return 0

    # If this essay already has facts (re-run case), drop the old set first
    # so the new extraction replaces rather than stacks.
    if source_essay_id:
        try:
            removed = await asyncio.to_thread(
                delete_facts_for_essay, user_id, source_essay_id
            )
            if removed:
                logger.info(
                    "memory: dropped %d stale facts for essay %s before re-extract",
                    removed,
                    source_essay_id,
                )
        except Exception as e:
            logger.warning("memory: stale-fact cleanup failed: %s", e)

    try:
        inserted = await asyncio.to_thread(
            bulk_insert_user_facts,
            user_id,
            facts,
            source="essay",
            source_essay_id=source_essay_id,
        )
        logger.info(
            "memory: extracted %d facts, inserted %d for user=%s essay=%s",
            len(facts),
            inserted,
            user_id,
            source_essay_id,
        )
        return inserted
    except Exception as e:
        logger.warning("memory: bulk insert failed: %s", e)
        return 0


async def distill_refinement_to_rule(instruction: str) -> Optional[str]:
    """Turn a user's free-form refinement instruction into a short rule.

    "Make the opening less flowery and please don't use em-dashes" -->
    "Avoid em-dashes; keep the opening plain rather than flowery."

    Returns None on any failure or if the instruction is too thin to
    distill. The caller queues the result in voice_profiles.pending_suggestions
    so the user can accept/reject through the existing review queue UI.
    """
    text = (instruction or "").strip()
    if len(text) < 4:
        return None

    sys_prompt = (
        "You convert a writer's one-off refinement request into ONE durable "
        "writing rule another LLM editor can apply to ALL future essays from "
        "this writer. The rule must be:\n"
        "  - One imperative sentence under 110 characters.\n"
        "  - Specific and prescriptive (e.g. 'Avoid em-dashes', "
        "'Lead every essay with a concrete scene before any abstraction').\n"
        "  - Generalizable beyond this single essay — not 'change paragraph 3'.\n"
        "If the request is too one-off to generalize, output the literal "
        "string NO_RULE.\n\n"
        "OUTPUT: just the rule sentence, no quotes, no preamble."
    )
    from .council import query_model

    try:
        res = await query_model(
            EXTRACTION_MODEL,
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": text},
            ],
            timeout=30.0,
            temperature=0.2,
        )
    except Exception as e:
        logger.warning("rule distillation call failed: %s", e)
        return None

    if not res or res.get("error"):
        return None
    raw = (res.get("content") or "").strip().strip('"').strip()
    if not raw or raw.upper().startswith("NO_RULE"):
        return None
    # Hard length cap; the system prompt asks for <=110 but trust nothing.
    if len(raw) > 200:
        raw = raw[:200].rstrip()
    return raw
