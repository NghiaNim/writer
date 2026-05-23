"""Iterative essay optimizer to reduce AI detection risk.

Uses detection_scorer to identify weak spots, then prompts a revision
model with targeted instructions. Repeats until the risk score drops
below threshold or max iterations are reached.

The optimizer does NOT re-run the full council pipeline. It takes a
finished essay and does targeted revisions — like a copy-editor pass
focused specifically on breaking AI fingerprints.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Dict, List, Optional

from .detection_scorer import (
    DetectionReport,
    full_analysis,
    split_sentences,
)

logger = logging.getLogger(__name__)

# The revision model should be different from the one that wrote the essay
# to break single-model fingerprints. Default to a fast model.
DEFAULT_REVISION_MODEL = "google:gemini-2.5-flash"

RISK_THRESHOLD = 0.35
MAX_ITERATIONS = 3


# ---------------------------------------------------------------------------
# Revision prompt generation
# ---------------------------------------------------------------------------

REVISION_SYSTEM = """You are a stealth editor. Your ONLY job is to revise the essay below so it reads as natural human writing — the kind a thoughtful person would produce, not a language model.

You will receive:
1. The essay to revise
2. A detection report listing specific weak spots

RULES:
- Preserve the essay's argument, claims, evidence, and overall structure.
- Do NOT add new ideas, sections, or conclusions. Do NOT pad the word count.
- Do NOT announce what you changed or add meta-commentary.
- Apply EVERY fix listed in the weak spots. Each one is a specific, actionable instruction.
- Output ONLY the revised essay text. Nothing else — no preamble, no explanation."""

REVISION_USER_TEMPLATE = """ESSAY TO REVISE:

{essay}

---

DETECTION REPORT — WEAK SPOTS TO FIX:

{weak_spots}

---

Revise the essay above, fixing every weak spot. Output only the revised essay."""


def build_revision_prompt(
    essay: str,
    report: DetectionReport,
) -> List[Dict[str, str]]:
    """Build the revision prompt from a detection report."""
    weak_spots_text = "\n".join(f"- {ws}" for ws in report.weak_spots)
    if not weak_spots_text:
        weak_spots_text = "- No specific weak spots identified, but the overall AI risk score is elevated. Introduce more sentence-length variation, use less predictable vocabulary, and break any rhythmic patterns."

    return [
        {"role": "system", "content": REVISION_SYSTEM},
        {"role": "user", "content": REVISION_USER_TEMPLATE.format(
            essay=essay,
            weak_spots=weak_spots_text,
        )},
    ]


# ---------------------------------------------------------------------------
# Optimization result
# ---------------------------------------------------------------------------

@dataclass
class OptimizationIteration:
    iteration: int
    report: DetectionReport
    revised_essay: Optional[str] = None
    revision_model: Optional[str] = None
    duration_s: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "iteration": self.iteration,
            "report": self.report.to_dict(),
            "duration_s": round(self.duration_s, 2),
        }
        if self.revision_model:
            d["revision_model"] = self.revision_model
        return d


@dataclass
class OptimizationResult:
    original_essay: str
    final_essay: str
    iterations: List[OptimizationIteration] = field(default_factory=list)
    converged: bool = False
    initial_risk: float = 0.0
    final_risk: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "final_essay": self.final_essay,
            "iterations": [it.to_dict() for it in self.iterations],
            "converged": self.converged,
            "initial_risk": round(self.initial_risk, 3),
            "final_risk": round(self.final_risk, 3),
            "improvement": round(self.initial_risk - self.final_risk, 3),
        }


# ---------------------------------------------------------------------------
# Main optimization loop
# ---------------------------------------------------------------------------

async def optimize_essay(
    essay: str,
    revision_model: str = DEFAULT_REVISION_MODEL,
    sapling_api_key: str = "",
    risk_threshold: float = RISK_THRESHOLD,
    max_iterations: int = MAX_ITERATIONS,
    skip_perplexity: bool = False,
    skip_sapling: bool = False,
) -> OptimizationResult:
    """Score → revise → score loop.

    Returns the best version of the essay along with per-iteration reports.
    """
    from .council import query_model

    result = OptimizationResult(original_essay=essay, final_essay=essay)
    current_essay = essay

    for i in range(max_iterations):
        t0 = time.monotonic()

        # Score current version
        report = await full_analysis(
            current_essay,
            sapling_api_key=sapling_api_key,
            skip_perplexity=skip_perplexity,
            skip_sapling=skip_sapling,
        )

        iteration = OptimizationIteration(
            iteration=i,
            report=report,
        )

        if i == 0:
            result.initial_risk = report.risk_score

        # Check if we're below threshold
        if report.risk_score < risk_threshold:
            iteration.duration_s = time.monotonic() - t0
            result.iterations.append(iteration)
            result.converged = True
            result.final_risk = report.risk_score
            result.final_essay = current_essay
            break

        # Not converged — revise
        if not report.weak_spots:
            iteration.duration_s = time.monotonic() - t0
            result.iterations.append(iteration)
            result.final_risk = report.risk_score
            result.final_essay = current_essay
            break

        messages = build_revision_prompt(current_essay, report)

        try:
            response = await query_model(
                revision_model, messages, timeout=120.0, temperature=0.8
            )
            revised = (response.get("content") or response.get("response") or "").strip()

            if revised and len(revised) > len(current_essay) * 0.5:
                current_essay = revised
                iteration.revised_essay = revised
                iteration.revision_model = revision_model
            else:
                logger.warning("Revision produced empty or too-short result; keeping previous version")
        except Exception as e:
            logger.error("Revision model error: %s", e)

        iteration.duration_s = time.monotonic() - t0
        result.iterations.append(iteration)

    # Final score if we exhausted iterations without converging
    if not result.converged:
        final_report = await full_analysis(
            current_essay,
            sapling_api_key=sapling_api_key,
            skip_perplexity=skip_perplexity,
            skip_sapling=skip_sapling,
        )
        result.final_risk = final_report.risk_score
        result.iterations.append(OptimizationIteration(
            iteration=len(result.iterations),
            report=final_report,
        ))
    result.final_essay = current_essay

    return result


# ---------------------------------------------------------------------------
# SSE streaming variant for the API
# ---------------------------------------------------------------------------

async def optimize_essay_stream(
    essay: str,
    revision_model: str = DEFAULT_REVISION_MODEL,
    sapling_api_key: str = "",
    risk_threshold: float = RISK_THRESHOLD,
    max_iterations: int = MAX_ITERATIONS,
    skip_perplexity: bool = False,
    skip_sapling: bool = False,
) -> AsyncGenerator[str, None]:
    """Streaming version that yields SSE events during optimization."""
    from .council import query_model

    current_essay = essay

    yield _sse("optimize_start", {"max_iterations": max_iterations, "threshold": risk_threshold})

    for i in range(max_iterations):
        t0 = time.monotonic()
        yield _sse("scoring_start", {"iteration": i})

        report = await full_analysis(
            current_essay,
            sapling_api_key=sapling_api_key,
            skip_perplexity=skip_perplexity,
            skip_sapling=skip_sapling,
        )

        yield _sse("scoring_complete", {
            "iteration": i,
            "risk_score": round(report.risk_score, 3),
            "risk_label": report.risk_label,
            "weak_spots": report.weak_spots,
            "burstiness_score": round(report.burstiness.score, 3),
            "vocab_score": round(report.vocab.score, 3),
            "phrase_count": len(report.ai_phrases),
            "sapling_score": round(report.sapling.overall_score, 4) if report.sapling.available else None,
            "perplexity_mean": round(report.perplexity.mean_perplexity, 1) if report.perplexity.available else None,
        })

        if report.risk_score < risk_threshold:
            yield _sse("converged", {
                "iteration": i,
                "risk_score": round(report.risk_score, 3),
                "essay": current_essay,
            })
            return

        if not report.weak_spots:
            yield _sse("no_weak_spots", {"iteration": i, "essay": current_essay})
            return

        yield _sse("revising_start", {"iteration": i, "model": revision_model})

        messages = build_revision_prompt(current_essay, report)
        try:
            response = await query_model(
                revision_model, messages, timeout=120.0, temperature=0.8
            )
            revised = (response.get("content") or response.get("response") or "").strip()

            if revised and len(revised) > len(current_essay) * 0.5:
                current_essay = revised
                yield _sse("revising_complete", {
                    "iteration": i,
                    "duration_s": round(time.monotonic() - t0, 2),
                })
            else:
                yield _sse("revision_failed", {
                    "iteration": i,
                    "reason": "empty or too short",
                })
                break
        except Exception as e:
            yield _sse("revision_error", {"iteration": i, "error": str(e)})
            break

    # Final scoring pass
    yield _sse("final_scoring", {})
    final_report = await full_analysis(
        current_essay,
        sapling_api_key=sapling_api_key,
        skip_perplexity=skip_perplexity,
        skip_sapling=skip_sapling,
    )
    yield _sse("optimize_complete", {
        "risk_score": round(final_report.risk_score, 3),
        "risk_label": final_report.risk_label,
        "essay": current_essay,
        "report": final_report.to_dict(),
    })


def _sse(event_type: str, data: Dict[str, Any]) -> str:
    return f"data: {json.dumps({'type': event_type, 'data': data})}\n\n"
