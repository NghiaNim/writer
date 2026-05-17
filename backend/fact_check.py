"""Post-Stage-3 fact-check pass.

A single Gemini Flash call reads the finished essay together with:
  * The user's known facts (`user_fact` rows the council has been
    accumulating across essays).
  * The intake brief from the current run (the Q&A answers the user
    just gave).

It returns a small list of FLAGS — specific claims in the essay that
either contradict something the user told us, or appear hallucinated
(specific facts stated as if true, with no supporting evidence
anywhere in the brief or fact corpus).

The pass is intentionally conservative:
  * Vague or general statements don't get flagged — they aren't
    fact-checkable.
  * Statements that obviously paraphrase a Q&A answer don't get
    flagged just because the wording shifted.
  * Hard cap on flag count so the panel never overwhelms the essay.

Failure mode: any exception returns an empty flag list. The essay
stands; the fact-check just doesn't surface anything.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

FACT_CHECK_MODEL = "google:gemini-2.5-flash"
MAX_FLAGS = 6
MAX_ESSAY_CHARS = 16_000
MAX_FACTS_FOR_PROMPT = 60
MAX_QA_FOR_PROMPT = 12


_SYSTEM_PROMPT = """You are a fact-checker reading a personal essay. The student wrote it themselves with AI help, and you have two reference sources to check the essay against:

  1. KNOWN FACTS — durable facts the system has accumulated about the student from past essays and intake answers. Treat these as true.
  2. INTAKE BRIEF — the Q&A the student just answered during this essay's prep. Treat these as true.

Your job: flag claims in the essay that look problematic. There are TWO categories of flag:

  CONTRADICTS — the essay says X but a known fact or the intake brief
                clearly says NOT X (or a different X).
  UNSUPPORTED — the essay makes a specific factual claim (a date, a
                number, a place, an event, a person's role) that is
                NOWHERE in the known facts or intake brief, AND that
                a reader would expect to be verifiable.

DO NOT flag:
  - Vague, general, or interpretive statements ("I felt that…", "the world is changing…").
  - Reasonable paraphrases of brief content even if the exact wording differs.
  - Claims that are obviously inference or opinion rather than fact.
  - Anything you're not at least 80% sure about.

Hard cap: at most 6 flags. If the essay is solid, return an empty list — that's the correct answer.

Each flag has:
  - "quote": a short exact substring of the essay (8-32 words) that contains the problematic claim. Must appear verbatim in the essay so the frontend can highlight it.
  - "status": exactly "contradicts" or "unsupported".
  - "note": one short sentence explaining the problem. Reference the specific fact or brief line if the status is "contradicts".

Output STRICT JSON, no markdown fences, no prose:
{"flags": [{"quote": "...", "status": "contradicts", "note": "..."}]}
"""


def _truncate(text: str, limit: int) -> str:
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n\n[... truncated ...]"


def _format_facts_for_prompt(facts: Optional[List[Dict[str, Any]]]) -> str:
    if not facts:
        return "(none on file)"
    lines: List[str] = []
    for f in facts[:MAX_FACTS_FOR_PROMPT]:
        text = (f.get("fact_text") or "").strip()
        if not text:
            continue
        cat = (f.get("category") or "general").strip().lower()
        lines.append(f"- [{cat}] {text}")
    return "\n".join(lines) if lines else "(none on file)"


def _format_qa_for_prompt(qa: Optional[List[Dict[str, Any]]]) -> str:
    if not qa:
        return "(no intake Q&A in this run)"
    lines: List[str] = []
    for entry in qa[:MAX_QA_FOR_PROMPT]:
        if not isinstance(entry, dict):
            continue
        q = (entry.get("question") or entry.get("prompt") or "").strip()
        a = (entry.get("answer") or "").strip()
        if not a:
            continue
        lines.append(f"Q: {q}\nA: {a}")
    return "\n\n".join(lines) if lines else "(no intake Q&A in this run)"


def _parse_flags(raw: str, essay_text: str) -> List[Dict[str, str]]:
    """Pull a list of {quote, status, note} dicts out of an LLM response.

    Also validates that each `quote` actually appears in the essay (case-
    insensitive substring match). The model occasionally paraphrases the
    quote — drop those because the frontend uses the quote as an anchor
    for the flag pin.
    """
    if not raw:
        return []
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
        return []
    items = parsed.get("flags")
    if not isinstance(items, list):
        return []

    essay_lower = (essay_text or "").lower()
    out: List[Dict[str, str]] = []
    seen_quotes: set[str] = set()
    for item in items[:MAX_FLAGS * 2]:  # parse a few extra to allow drop-outs
        if not isinstance(item, dict):
            continue
        quote = str(item.get("quote") or "").strip().strip('"').strip("'").strip()
        status = str(item.get("status") or "").strip().lower()
        note = str(item.get("note") or "").strip()
        if status not in ("contradicts", "unsupported"):
            continue
        if not quote or len(quote) < 8 or len(quote) > 400:
            continue
        if not note or len(note) > 280:
            continue
        # The quote must appear in the essay verbatim (case-insensitive).
        if quote.lower() not in essay_lower:
            continue
        # Dedupe — the model sometimes flags overlapping passages twice.
        norm = quote.lower()
        if norm in seen_quotes:
            continue
        seen_quotes.add(norm)
        out.append({"quote": quote, "status": status, "note": note})
        if len(out) >= MAX_FLAGS:
            break
    return out


async def fact_check_essay(
    *,
    essay_text: str,
    facts: Optional[List[Dict[str, Any]]] = None,
    intake_qa: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, str]]:
    """Run the fact-check pass. Returns a list of flag dicts.

    Empty list on any failure or when the essay text is too short to
    meaningfully check.
    """
    essay = (essay_text or "").strip()
    if len(essay) < 200:
        return []

    facts_block = _format_facts_for_prompt(facts)
    qa_block = _format_qa_for_prompt(intake_qa)
    essay_for_prompt = _truncate(essay, MAX_ESSAY_CHARS)

    user_prompt = (
        f"KNOWN FACTS:\n{facts_block}\n\n"
        f"INTAKE BRIEF:\n{qa_block}\n\n"
        f"ESSAY:\n{essay_for_prompt}\n\n"
        "Return the strict JSON object specified."
    )

    # Lazy import to avoid council ↔ fact_check import cycles.
    from .council import query_model

    try:
        res = await query_model(
            FACT_CHECK_MODEL,
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            timeout=45.0,
            temperature=0.2,
        )
    except Exception as e:
        logger.warning("fact_check call failed: %s", e)
        return []

    if not res or res.get("error"):
        if res:
            logger.warning(
                "fact_check error: %s", res.get("error_message") or res
            )
        return []

    return _parse_flags(res.get("content") or "", essay)
