"""Structured expansion of an interim Q&A answer.

One Gemini Flash call per submitted answer that turns the user's freeform
reply into:

  * `bullets`  — 2–5 short restatement beats, second person.
  * `entities` — tagged people/places/dates/numbers/orgs/works.
  * `inferred` — 0–2 clearly-hedged implications ("Likely:", "Suggests:").

Plus a pure-Python `find_related_facts` step that scores recent active
`user_fact` rows by overlap with the new answer's entity phrases and
content tokens. Top hits drive the "Building on what you've told us
before" line in the UI.

Cheap (~$0.0001 / answer) and fully isolated — any failure returns
empty lists and the UI falls back to the verbatim echo.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Optional

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)

EXPANSION_MODEL = "google:gemini-2.5-flash"

MAX_BULLETS = 5
MAX_ENTITIES = 6
MAX_INFERRED = 2
MAX_RELATED = 3

_VALID_ENTITY_TYPES = {"person", "place", "date", "number", "org", "work", "other"}

_SYSTEM_PROMPT = """You are a writing coach processing a freeform answer the user just gave to one of the council's questions. Your job is to surface what they said so it feels like the council is listening, organizing, and pattern-matching — not just transcribing.

Return a STRICT JSON object with these fields:

{
  "bullets":  [...]  — 2 to 5 short bullets that restate what the user said.
                       Each bullet is one concrete beat. Break composite
                       answers into separate bullets. Under 18 words each.
                       Second person ("you"). Faithful to the literal
                       answer — DO NOT invent.
  "entities": [...]  — 0 to 6 worth-tagging entities. Each is
                       {"type": "<one of: person|place|date|number|org|work|other>",
                        "value": "<the exact phrase from the answer>"}.
                       Skip generic phrases ("the company" — bad;
                       "Stripe" — good).
  "inferred": [...]  — 0 to 2 implications that follow naturally from the
                       answer. ONE short hedged sentence each, prefixed
                       with a reasoning move ("Likely:", "Suggests:",
                       "Reads like:"). Skip if you cannot infer anything
                       beyond the literal answer.
}

Rules:
  - JSON only. No markdown fences, no commentary around the object.
  - If the answer is too thin (one word, "idk", "n/a"), return
    {"bullets": [], "entities": [], "inferred": []}.
  - NEVER hallucinate biographical facts. Inference must plausibly tie
    back to the literal answer.
"""


def _build_user_prompt(question: str, answer: str) -> str:
    return (
        f"QUESTION ASKED:\n{question.strip()}\n\n"
        f"USER'S ANSWER:\n{answer.strip()}\n\n"
        "Return the strict JSON object specified."
    )


def _parse_expansion(raw: str) -> Dict[str, Any]:
    empty = {"bullets": [], "entities": [], "inferred": []}
    if not raw:
        return empty
    text = raw.strip()
    parsed: Optional[Dict[str, Any]] = None
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = None

    if not isinstance(parsed, dict):
        return empty

    bullets: List[str] = []
    for b in (parsed.get("bullets") or [])[:MAX_BULLETS]:
        if not isinstance(b, str):
            continue
        t = b.strip().strip('"').strip()
        if t and len(t) <= 240:
            bullets.append(t)

    entities: List[Dict[str, str]] = []
    for e in (parsed.get("entities") or [])[:MAX_ENTITIES]:
        if not isinstance(e, dict):
            continue
        etype = str(e.get("type") or "other").strip().lower()
        if etype not in _VALID_ENTITY_TYPES:
            etype = "other"
        value = str(e.get("value") or "").strip().strip('"').strip()
        if value and len(value) <= 120:
            entities.append({"type": etype, "value": value})

    inferred: List[str] = []
    for i in (parsed.get("inferred") or [])[:MAX_INFERRED]:
        if not isinstance(i, str):
            continue
        t = i.strip().strip('"').strip()
        if t and len(t) <= 240:
            inferred.append(t)

    return {"bullets": bullets, "entities": entities, "inferred": inferred}


async def expand_answer(question: str, answer: str) -> Dict[str, Any]:
    """Single Flash call. Returns {bullets, entities, inferred}. Empty
    lists on any failure or when the answer is too thin to expand."""
    q = (question or "").strip()
    a = (answer or "").strip()
    empty = {"bullets": [], "entities": [], "inferred": []}
    if not a or len(a) < 4:
        return empty

    # Lazy import — council imports a few of our siblings at module load.
    from .council import query_model

    try:
        res = await query_model(
            EXPANSION_MODEL,
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": _build_user_prompt(q, a)},
            ],
            timeout=20.0,
            temperature=0.3,
        )
    except Exception as e:
        logger.warning("intake expansion call failed: %s", e)
        return empty

    if not res or res.get("error"):
        if res:
            logger.warning(
                "intake expansion error: %s", res.get("error_message") or res
            )
        return empty
    return _parse_expansion(res.get("content") or "")


# ---------------------------------------------------------------------------
# Related-fact lookup — pure Python, no LLM
# ---------------------------------------------------------------------------

_STOPWORDS = {
    "the","a","an","and","or","but","of","in","on","at","to","for","with",
    "from","by","is","was","are","were","be","been","being","i","you","he",
    "she","it","we","they","my","your","his","her","our","their","me","us",
    "them","this","that","these","those","do","does","did","done","have",
    "has","had","will","would","could","should","can","may","might","must",
    "not","no","yes","so","if","then","than","as","also","just","very",
    "really","very","much","more","most","less","least","some","any","one",
    "two","three","like","about","into","over","under","out","up","down",
    "off","over","again","when","where","what","which","who","whom","why",
    "how","because","while","before","after","during","through","into",
}


def _tokens(text: str) -> List[str]:
    cleaned = re.sub(r"[^\w\s]", " ", (text or "").lower())
    return [t for t in cleaned.split() if t and t not in _STOPWORDS and len(t) >= 3]


def _entity_phrases(entities: List[Dict[str, str]]) -> List[str]:
    return [
        (e.get("value") or "").strip()
        for e in (entities or [])
        if isinstance(e, dict) and (e.get("value") or "").strip()
    ]


async def find_related_facts(
    user_id: str,
    question: str,
    answer: str,
    entities: List[Dict[str, str]],
) -> List[Dict[str, Any]]:
    """Score the user's recent active facts against the new answer +
    extracted entities, and return up to MAX_RELATED top hits.

    Scoring is deliberately simple:
      * Each entity phrase that appears as a substring of the fact: +5
      * Each answer token that also appears in the fact's tokens: +1
      * Each question token in the fact's tokens (capped at +2): +1

    Anything scoring < 2 is dropped — a single token in common is noise.
    """
    if not user_id:
        return []

    sb = get_supabase()
    try:
        rows = await asyncio.to_thread(
            lambda: (
                sb.table("user_fact")
                .select("id, fact_text, category, source, created_at")
                .eq("user_id", user_id)
                .is_("archived_at", "null")
                .order("created_at", desc=True)
                .limit(60)
                .execute()
            )
        )
    except Exception as e:
        logger.warning("intake expansion related-fact load failed: %s", e)
        return []

    candidates = list(getattr(rows, "data", None) or [])
    if not candidates:
        return []

    entity_phrases = [p.lower() for p in _entity_phrases(entities) if len(p) >= 3]
    answer_tokens = set(_tokens(answer))
    question_tokens = set(_tokens(question))

    scored: List[Dict[str, Any]] = []
    for row in candidates:
        text = (row.get("fact_text") or "").strip()
        if not text:
            continue
        text_lower = text.lower()
        fact_tokens = set(_tokens(text))

        score = 0
        for phrase in entity_phrases:
            if phrase and phrase in text_lower:
                score += 5
        score += len(answer_tokens & fact_tokens)
        score += min(2, len(question_tokens & fact_tokens))

        if score >= 2:
            scored.append({**row, "_score": score})

    scored.sort(key=lambda r: (-r["_score"], r.get("created_at") or ""))
    return [
        {k: v for k, v in r.items() if k != "_score"}
        for r in scored[:MAX_RELATED]
    ]


async def expand_intake_answer(
    *,
    user_id: str,
    question: str,
    answer: str,
) -> Dict[str, Any]:
    """Top-level helper used by the endpoint. Runs the Flash expansion,
    then the related-fact lookup using the entities the Flash call
    surfaced. Returns a dict ready to JSON-serialize back to the client.
    """
    if not (answer or "").strip():
        return {
            "bullets": [],
            "entities": [],
            "inferred": [],
            "related_facts": [],
        }

    expansion = await expand_answer(question, answer)
    related = await find_related_facts(
        user_id=user_id,
        question=question,
        answer=answer,
        entities=expansion.get("entities") or [],
    )
    return {**expansion, "related_facts": related}
