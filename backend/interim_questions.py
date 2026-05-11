"""Interim questions: keep the user occupied while the council is drafting.

While stages 1 and 2 run (~30-90s of dead time), the UI surfaces 1-3 short
questions tailored to (their topic, what they've already told us, the gaps in
the council's draft attempts). Their answers feed two places:

  1. The chairman's stage-3 prompt — so the answer materially affects the
     final essay, not just the next one.
  2. The user_fact table — every answer is run through memory_extraction so
     biographical details accumulate in a structured, searchable way.

Two surfaces in this module:

  generate_interim_questions(...)  → list[{question_id, question}]
  answer buffer (process-local)    → in-flight Q&A for the current run

The buffer is intentionally process-local: the chairman reads from it at
stage-3 time. Persistence to user_fact happens in parallel via
memory_extraction so nothing is lost if the process restarts mid-run.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Same model as memory extraction — fast, cheap, reliable for short JSON.
QUESTION_MODEL = "google:gemini-2.5-flash"

# Hard caps so we never feel like an interrogation.
MAX_QUESTIONS_PER_BATCH = 2
MAX_QUESTIONS_PER_RUN = 3

# Stage 1 drafts can be long; clip each one for the question prompt.
_DRAFT_EXCERPT_CHARS = 1200


# ---------------------------------------------------------------------------
# Process-local answer buffer
# ---------------------------------------------------------------------------
#
# Keyed by conversation_id. Each value is a list of {question_id, question,
# answer, ts} dicts. event_generator clears the entry at the start of a run
# and reads it before stage 3.

_run_buffers: Dict[str, List[Dict[str, Any]]] = {}


def reset_run_buffer(conversation_id: str) -> None:
    _run_buffers[conversation_id] = []


def get_run_buffer(conversation_id: str) -> List[Dict[str, Any]]:
    return list(_run_buffers.get(conversation_id) or [])


def append_run_answer(
    conversation_id: str,
    *,
    question_id: str,
    question: str,
    answer: str,
    skipped: bool = False,
) -> None:
    """Append a Q&A to the current run buffer. Silently no-ops if the run has
    already finished (buffer cleared).

    Skipped answers ARE recorded (with empty `answer` and `skipped=True`) so
    the chairman wait-loop can short-circuit instead of timing out when the
    user clicks Skip. The downstream prompt block already filters out empty
    answers, so this doesn't pollute the chairman's context.
    """
    if conversation_id not in _run_buffers:
        # Late answer — the run already finished. Drop it on the floor for
        # stage 3 purposes; the caller is expected to also persist to
        # user_fact, which we never want to lose.
        return
    _run_buffers[conversation_id].append(
        {
            "question_id": question_id,
            "question": (question or "").strip(),
            "answer": (answer or "").strip(),
            "skipped": bool(skipped),
        }
    )


def clear_run_buffer(conversation_id: str) -> None:
    _run_buffers.pop(conversation_id, None)


async def wait_for_answer(
    conversation_id: str, question_id: str, timeout_s: float = 25.0
) -> Optional[Dict[str, Any]]:
    """Poll the run buffer until an entry with `question_id` appears, or the
    timeout elapses. Returns the buffer entry (which may have skipped=True
    and empty answer), or None on timeout / cleared buffer.

    Used by the chairman clarification flow: emit a question, wait, then
    proceed to stage 3 with whatever (or nothing) the user said.
    """
    if not conversation_id or not question_id:
        return None
    deadline = asyncio.get_event_loop().time() + max(1.0, float(timeout_s))
    while True:
        if conversation_id not in _run_buffers:
            # Buffer was cleared (run cancelled / finished). Give up.
            return None
        for entry in _run_buffers[conversation_id]:
            if entry.get("question_id") == question_id:
                return entry
        if asyncio.get_event_loop().time() >= deadline:
            return None
        await asyncio.sleep(0.4)


# ---------------------------------------------------------------------------
# Question generation
# ---------------------------------------------------------------------------


def _safe_json(s: str) -> Optional[Dict[str, Any]]:
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        m = re.search(r"\{.*\}", s, flags=re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


def _excerpt_drafts(stage1_results: List[Dict[str, Any]]) -> str:
    """Pull short excerpts from up to 3 successful stage-1 drafts so the
    question generator can spot what the drafts hand-wave or invent."""
    out: List[str] = []
    for i, r in enumerate(stage1_results or []):
        if r.get("error"):
            continue
        text = r.get("response") or ""
        if not isinstance(text, str):
            text = str(text)
        text = text.strip()
        if not text:
            continue
        clip = text[:_DRAFT_EXCERPT_CHARS]
        if len(text) > _DRAFT_EXCERPT_CHARS:
            clip = clip + "\n[...]"
        out.append(f"DRAFT {chr(65 + i)}:\n{clip}")
        if len(out) >= 3:
            break
    return "\n\n".join(out)


def _format_known_facts(facts: List[Dict[str, Any]]) -> str:
    if not facts:
        return "(none yet)"
    lines: List[str] = []
    for f in facts[:24]:
        text = (f.get("fact_text") or "").strip()
        if not text:
            continue
        cat = (f.get("category") or "general").strip()
        lines.append(f"- [{cat}] {text}")
    return "\n".join(lines) if lines else "(none yet)"


def _format_recent_qa(recent_qa: List[Dict[str, Any]]) -> str:
    if not recent_qa:
        return "(none)"
    out: List[str] = []
    for item in recent_qa[-6:]:
        q = (item.get("question") or "").strip()
        a = (item.get("answer") or "").strip()
        if q:
            out.append(f"Q: {q}\nA: {a or '(skipped)'}")
    return "\n\n".join(out) if out else "(none)"


_SYSTEM_PROMPT = """You are an interview coach helping a writer surface specific, true details about their life while their essay is being drafted.

You will get:
  - the writing prompt or topic
  - what we already know about the writer (durable facts)
  - questions we've already asked this run (DO NOT repeat or rephrase)
  - excerpts from draft attempts the council just produced (use these to spot vague claims, hand-waved details, or invented specifics that the writer should ground)

Output ONE OR TWO short questions that:
  - are specific (not "tell me about yourself")
  - prefer questions whose answers would make the current drafts more concrete (a name, a date, a number, a moment, a contradiction, a sensory detail)
  - never re-ask anything in the known-facts block
  - never re-ask anything in the asked-this-run block
  - never feel like an interrogation; sound like a curious editor
  - are answerable in 1-3 sentences
  - if the drafts hallucinate a specific (a teacher's name, a year, a place), ask the writer to ground that specific

If you cannot ask anything genuinely useful, return an empty list.

OUTPUT — strict JSON, no markdown fences, no commentary:
{"questions": ["...", "..."]}"""


async def generate_interim_questions(
    *,
    topic: str,
    user_query: str,
    known_facts: List[Dict[str, Any]],
    asked_this_run: List[Dict[str, Any]],
    stage1_drafts: Optional[List[Dict[str, Any]]] = None,
    n_remaining: int = MAX_QUESTIONS_PER_BATCH,
) -> List[Dict[str, str]]:
    """Generate up to `n_remaining` (capped at MAX_QUESTIONS_PER_BATCH)
    questions tailored to this writer + this draft. Returns
    [{question_id, question}, ...]; empty list on any failure or if the
    model decides it has nothing fresh to ask."""
    n_remaining = max(0, min(int(n_remaining or 0), MAX_QUESTIONS_PER_BATCH))
    if n_remaining == 0:
        return []

    parts: List[str] = []
    topic_line = (topic or "").strip()
    if topic_line:
        parts.append(f"TOPIC: {topic_line}")
    if user_query:
        parts.append(f"USER PROMPT:\n{user_query.strip()[:2000]}")
    parts.append("KNOWN FACTS:\n" + _format_known_facts(known_facts))
    parts.append("ASKED THIS RUN (DO NOT REPEAT):\n" + _format_recent_qa(asked_this_run))
    drafts_block = _excerpt_drafts(stage1_drafts or [])
    if drafts_block:
        parts.append("CURRENT DRAFT EXCERPTS:\n" + drafts_block)
    parts.append(f"Return at most {n_remaining} question(s). Strict JSON only.")
    user_prompt = "\n\n".join(parts)

    from .council import query_model

    try:
        res = await query_model(
            QUESTION_MODEL,
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            timeout=30.0,
            temperature=0.6,
        )
    except Exception as e:
        logger.warning("interim question generation failed: %s", e)
        return []

    if not res or res.get("error"):
        return []
    parsed = _safe_json((res.get("content") or "").strip())
    if not isinstance(parsed, dict):
        return []
    raw = parsed.get("questions") or []
    if not isinstance(raw, list):
        return []

    out: List[Dict[str, str]] = []
    seen: set[str] = set()
    for q in raw:
        text = str(q or "").strip().strip('"')
        if not text or len(text) > 280:
            continue
        norm = re.sub(r"\s+", " ", text.lower())
        if norm in seen:
            continue
        seen.add(norm)
        out.append({"question_id": str(uuid.uuid4()), "question": text})
        if len(out) >= n_remaining:
            break
    return out


# ---------------------------------------------------------------------------
# Stage-3 enrichment block
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Chairman clarification (one final question before stage 3)
# ---------------------------------------------------------------------------
#
# After stage 2 and just before the chairman writes the final essay, we run
# ONE small Gemini-Flash call asking: "if you had to ask the writer one
# question that would change this essay from generic to grounded, what would
# it be?" If the answer is yes, we emit it as a clarification_question SSE
# event and wait briefly for a reply. The chairman then writes the essay
# with that answer in hand.
#
# Unlike interim questions, this is the chairman's voice — pinned to a
# specific vague claim in the drafts. The system prompt explicitly forces
# the model to quote the phrase it wants grounded.


_CLARIFICATION_PROMPT = """You are the chairman about to write a final essay. Before you commit, decide whether ONE more question to the writer would meaningfully change the essay.

You will read:
  - the writing prompt
  - the council members' draft attempts
  - what we already know about the writer
  - any questions we already asked this run

Output ONE question only if BOTH are true:
  (a) the drafts make a claim that is vague, generic, or invented (a hand-waved name, an unnamed teacher, a fuzzy date, a "various challenges" without specifics) AND
  (b) grounding that claim with the writer's real answer would materially improve the final essay.

The question must:
  - quote or reference the specific phrase from the drafts you want grounded
  - be answerable in one or two sentences
  - never repeat anything in the known-facts or asked-this-run blocks
  - never be a generic interview question ("tell me more about your background")

If no such question exists — the drafts are already grounded, or the only gaps are minor — return SKIP.

OUTPUT — strict JSON, no markdown fences, no commentary:
{"question": "..."}      // ask
{"question": "SKIP"}     // do nothing"""


async def generate_chairman_clarification(
    *,
    topic: str,
    user_query: str,
    known_facts: List[Dict[str, Any]],
    asked_this_run: List[Dict[str, Any]],
    stage1_drafts: Optional[List[Dict[str, Any]]] = None,
) -> Optional[Dict[str, str]]:
    """Return {question_id, question} or None if the chairman has no useful
    ask. Single Gemini Flash call; any failure returns None silently."""
    parts: List[str] = []
    if topic and topic.strip():
        parts.append(f"TOPIC: {topic.strip()}")
    if user_query:
        parts.append(f"USER PROMPT:\n{user_query.strip()[:2000]}")
    parts.append("KNOWN FACTS:\n" + _format_known_facts(known_facts))
    parts.append("ASKED THIS RUN (DO NOT REPEAT):\n" + _format_recent_qa(asked_this_run))
    drafts_block = _excerpt_drafts(stage1_drafts or [])
    if drafts_block:
        parts.append("DRAFTS THE COUNCIL JUST PRODUCED:\n" + drafts_block)
    parts.append("Return strict JSON only.")
    user_prompt = "\n\n".join(parts)

    from .council import query_model

    try:
        res = await query_model(
            QUESTION_MODEL,
            [
                {"role": "system", "content": _CLARIFICATION_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            timeout=25.0,
            temperature=0.4,
        )
    except Exception as e:
        logger.warning("clarification generation failed: %s", e)
        return None

    if not res or res.get("error"):
        return None
    parsed = _safe_json((res.get("content") or "").strip())
    if not isinstance(parsed, dict):
        return None
    text = str(parsed.get("question") or "").strip().strip('"')
    if not text or text.upper().startswith("SKIP") or len(text) > 320:
        return None
    # De-dup against questions asked this run (case-insensitive).
    norm = re.sub(r"\s+", " ", text.lower())
    for prior in asked_this_run or []:
        prior_text = (prior.get("question") or "").strip().lower()
        if prior_text and re.sub(r"\s+", " ", prior_text) == norm:
            return None
    return {"question_id": str(uuid.uuid4()), "question": text}


def format_in_flight_qa_block(qa: List[Dict[str, Any]]) -> str:
    """Render answered Q&A from the run buffer into a block for the chairman.

    Skipped questions (empty answer) are dropped. Empty list -> empty string
    so existing prompt templates without this placeholder still work.
    """
    pairs: List[str] = []
    for item in qa or []:
        q = (item.get("question") or "").strip()
        a = (item.get("answer") or "").strip()
        if not q or not a:
            continue
        pairs.append(f"Q: {q}\nA: {a}")
    if not pairs:
        return ""
    intro = (
        "FRESH DETAILS THE WRITER SHARED WHILE YOU WERE DRAFTING (these were "
        "captured between stage 1 and now; treat as authoritative; weave into "
        "the final essay where they make claims more concrete; do not "
        "contradict them):"
    )
    return intro + "\n\n" + "\n\n".join(pairs)
