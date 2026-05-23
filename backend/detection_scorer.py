"""AI writing detection scorer.

Three-layer detection analysis for essays:
  Layer 1 (always available): Burstiness + AI phrase detection (pure Python)
  Layer 2 (optional, torch+transformers): Perplexity via GPT-2
  Layer 3 (optional, API key): Sapling AI detector

Used by essay_optimizer.py to iteratively revise essays until they pass
detection thresholds.
"""

from __future__ import annotations

import logging
import math
import re
import statistics
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Sentence / paragraph splitting
# ---------------------------------------------------------------------------

_SENTENCE_RE = re.compile(
    r'(?<=[.!?])'           # lookbehind for terminal punctuation
    r'(?:\s*["”)]*)'   # optional closing quotes/parens
    r'\s+'                   # whitespace between sentences
    r'(?=[A-Z“"(])',    # lookahead for uppercase / opening quote
)

_PARAGRAPH_RE = re.compile(r'\n\s*\n')


def split_sentences(text: str) -> List[str]:
    """Split text into sentences. Handles common abbreviations."""
    text = text.strip()
    if not text:
        return []
    # Protect common abbreviations from splitting
    protected = text
    for abbr in ("Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.",
                 "vs.", "etc.", "e.g.", "i.e.", "U.S.", "U.K."):
        protected = protected.replace(abbr, abbr.replace(".", "\x00"))

    parts = _SENTENCE_RE.split(protected)
    sentences = []
    for p in parts:
        s = p.replace("\x00", ".").strip()
        if s:
            sentences.append(s)
    return sentences


def split_paragraphs(text: str) -> List[str]:
    parts = _PARAGRAPH_RE.split(text.strip())
    return [p.strip() for p in parts if p.strip()]


def word_count(text: str) -> int:
    return len(text.split())


# ---------------------------------------------------------------------------
# Layer 1: Burstiness analysis
# ---------------------------------------------------------------------------

@dataclass
class BurstinessReport:
    sentence_lengths: List[int] = field(default_factory=list)
    paragraph_lengths: List[int] = field(default_factory=list)
    sent_mean: float = 0.0
    sent_std: float = 0.0
    sent_cv: float = 0.0      # coefficient of variation (std/mean)
    para_mean: float = 0.0
    para_std: float = 0.0
    para_cv: float = 0.0
    short_sentence_ratio: float = 0.0  # sentences <= 8 words
    long_sentence_ratio: float = 0.0   # sentences >= 25 words
    max_consecutive_similar: int = 0   # longest run of similar-length sentences
    score: float = 0.0  # 0 = flat/AI-like, 1 = bursty/human-like

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sentence_lengths": self.sentence_lengths,
            "paragraph_lengths": self.paragraph_lengths,
            "sent_mean": round(self.sent_mean, 2),
            "sent_std": round(self.sent_std, 2),
            "sent_cv": round(self.sent_cv, 3),
            "para_mean": round(self.para_mean, 2),
            "para_std": round(self.para_std, 2),
            "para_cv": round(self.para_cv, 3),
            "short_sentence_ratio": round(self.short_sentence_ratio, 3),
            "long_sentence_ratio": round(self.long_sentence_ratio, 3),
            "max_consecutive_similar": self.max_consecutive_similar,
            "score": round(self.score, 3),
        }


def _consecutive_similar(lengths: List[int], tolerance: float = 0.25) -> int:
    """Longest run of consecutive sentences within `tolerance` of each other."""
    if len(lengths) < 2:
        return 0
    max_run = 1
    current_run = 1
    for i in range(1, len(lengths)):
        avg = (lengths[i] + lengths[i - 1]) / 2
        if avg > 0 and abs(lengths[i] - lengths[i - 1]) / avg <= tolerance:
            current_run += 1
            max_run = max(max_run, current_run)
        else:
            current_run = 1
    return max_run


def compute_burstiness(text: str) -> BurstinessReport:
    """Analyze sentence and paragraph length variance."""
    sentences = split_sentences(text)
    paragraphs = split_paragraphs(text)

    report = BurstinessReport()

    if len(sentences) < 3:
        report.score = 0.5  # too short to judge
        return report

    sent_lens = [word_count(s) for s in sentences]
    para_lens = [word_count(p) for p in paragraphs]

    report.sentence_lengths = sent_lens
    report.paragraph_lengths = para_lens
    report.sent_mean = statistics.mean(sent_lens)
    report.sent_std = statistics.stdev(sent_lens) if len(sent_lens) > 1 else 0
    report.sent_cv = report.sent_std / report.sent_mean if report.sent_mean > 0 else 0
    report.short_sentence_ratio = sum(1 for l in sent_lens if l <= 8) / len(sent_lens)
    report.long_sentence_ratio = sum(1 for l in sent_lens if l >= 25) / len(sent_lens)
    report.max_consecutive_similar = _consecutive_similar(sent_lens)

    if len(para_lens) > 1:
        report.para_mean = statistics.mean(para_lens)
        report.para_std = statistics.stdev(para_lens)
        report.para_cv = report.para_std / report.para_mean if report.para_mean > 0 else 0

    # Score: combine multiple signals into 0-1 score.
    # Human text: CV ~0.4-0.7, short ratio ~0.1-0.25, long ratio ~0.1-0.2
    # AI text: CV ~0.1-0.25, short ratio ~0.0-0.05, long ratio ~0.0-0.05
    cv_score = min(report.sent_cv / 0.55, 1.0)  # target CV ~0.55
    short_score = min(report.short_sentence_ratio / 0.15, 1.0)
    long_score = min(report.long_sentence_ratio / 0.15, 1.0)

    # Penalize long runs of similar-length sentences
    run_penalty = max(0, (report.max_consecutive_similar - 3)) * 0.1
    run_penalty = min(run_penalty, 0.3)

    # Paragraph variance bonus
    para_bonus = min(report.para_cv / 0.5, 1.0) * 0.15 if len(para_lens) > 2 else 0

    report.score = max(0, min(1,
        cv_score * 0.40 +
        short_score * 0.15 +
        long_score * 0.15 +
        para_bonus +
        0.15 -  # base
        run_penalty
    ))

    return report


# ---------------------------------------------------------------------------
# Layer 1: AI phrase detection
# ---------------------------------------------------------------------------

@dataclass
class AIPhraseMatch:
    phrase: str
    position: int  # char offset
    sentence_index: int
    category: str  # "vocabulary", "structure", "preamble", "closer"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "phrase": self.phrase,
            "position": self.position,
            "sentence_index": self.sentence_index,
            "category": self.category,
        }


# Organized by category so revision instructions can be specific.
AI_PHRASES: Dict[str, List[str]] = {
    "vocabulary": [
        "delve into", "delve deeper", "delves into",
        "navigate the complexities", "navigating the",
        "leverage", "leveraging", "leveraged",
        "robust", "seamless", "seamlessly",
        "holistic", "multifaceted", "nuanced",
        "intricate", "tapestry", "landscape of",
        "realm of", "journey of", "underscore",
        "foster", "harness", "pivotal",
        "crucial", "essential", "vital", "paramount",
        "transformative", "groundbreaking",
        "comprehensive", "facilitate", "utilize",
    ],
    "preamble": [
        "it's important to note",
        "it's worth noting",
        "it's important to remember",
        "it's worth mentioning",
        "keep in mind that",
        "it bears mentioning",
        "it should be noted",
        "one might argue",
        "it goes without saying",
    ],
    "structure": [
        "not just", "but also",  # "not just X but Y" construction
        "from beginners to experts",
        "from x to y",
        "in today's fast-paced world",
        "in the ever-evolving",
        "at the heart of",
        "plays a key role",
        "stands as a testament",
        "speaks volumes",
        "a double-edged sword",
        "the elephant in the room",
        "throughout human history",
        "since the dawn of",
        "in conclusion",
        "in essence",
        "ultimately,",
    ],
    "closer": [
        "by embracing",
        "as we move forward",
        "as we navigate",
        "the path forward",
        "a brighter future",
        "a better future",
        "paving the way",
        "only time will tell",
    ],
}


def detect_ai_phrases(text: str) -> List[AIPhraseMatch]:
    """Find AI-tell phrases in the text."""
    text_lower = text.lower()
    sentences = split_sentences(text)
    matches = []

    for category, phrases in AI_PHRASES.items():
        for phrase in phrases:
            start = 0
            while True:
                idx = text_lower.find(phrase.lower(), start)
                if idx == -1:
                    break

                # Find which sentence this belongs to
                char_count = 0
                sent_idx = 0
                for i, s in enumerate(sentences):
                    # Rough: find sentence containing this position
                    pos = text_lower.find(s.lower(), char_count)
                    if pos != -1 and pos <= idx < pos + len(s):
                        sent_idx = i
                        break
                    char_count = pos + len(s) if pos != -1 else char_count + len(s)

                matches.append(AIPhraseMatch(
                    phrase=phrase,
                    position=idx,
                    sentence_index=sent_idx,
                    category=category,
                ))
                start = idx + len(phrase)

    return matches


# ---------------------------------------------------------------------------
# Layer 1: Vocabulary analysis
# ---------------------------------------------------------------------------

@dataclass
class VocabReport:
    total_words: int = 0
    unique_words: int = 0
    type_token_ratio: float = 0.0  # unique/total (higher = more diverse)
    hapax_ratio: float = 0.0       # words used exactly once / total
    score: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_words": self.total_words,
            "unique_words": self.unique_words,
            "type_token_ratio": round(self.type_token_ratio, 3),
            "hapax_ratio": round(self.hapax_ratio, 3),
            "score": round(self.score, 3),
        }


def compute_vocab_diversity(text: str) -> VocabReport:
    """Measure vocabulary richness. AI tends toward mid-frequency vocabulary."""
    words = re.findall(r'\b[a-z]+\b', text.lower())
    report = VocabReport()
    if len(words) < 10:
        report.score = 0.5
        return report

    report.total_words = len(words)
    freq: Dict[str, int] = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1

    report.unique_words = len(freq)
    report.type_token_ratio = report.unique_words / report.total_words
    hapax = sum(1 for c in freq.values() if c == 1)
    report.hapax_ratio = hapax / report.total_words

    # Human text: TTR ~0.55-0.75 for essays, hapax ~0.35-0.55
    # AI text: TTR ~0.45-0.55, hapax ~0.25-0.35
    ttr_score = min((report.type_token_ratio - 0.35) / 0.3, 1.0)
    hapax_score = min((report.hapax_ratio - 0.2) / 0.25, 1.0)
    report.score = max(0, min(1, ttr_score * 0.5 + hapax_score * 0.5))

    return report


# ---------------------------------------------------------------------------
# Layer 1: Sentence start diversity
# ---------------------------------------------------------------------------

def compute_sentence_start_diversity(text: str) -> float:
    """How varied are sentence openings? Returns 0-1 (1 = fully diverse)."""
    sentences = split_sentences(text)
    if len(sentences) < 4:
        return 0.5

    starts = []
    for s in sentences:
        words = s.split()
        if words:
            starts.append(words[0].lower())

    if not starts:
        return 0.5

    unique = len(set(starts))
    return min(unique / len(starts), 1.0)


# ---------------------------------------------------------------------------
# Layer 2: Perplexity via GPT-2 (optional)
# ---------------------------------------------------------------------------

_gpt2_model = None
_gpt2_tokenizer = None


def _load_gpt2():
    """Lazy-load GPT-2. Returns (model, tokenizer) or (None, None)."""
    global _gpt2_model, _gpt2_tokenizer
    if _gpt2_model is not None:
        return _gpt2_model, _gpt2_tokenizer
    try:
        import torch
        from transformers import GPT2LMHeadModel, GPT2TokenizerFast
    except ImportError:
        logger.info("torch/transformers not installed — perplexity scoring disabled")
        return None, None

    logger.info("Loading GPT-2 for perplexity scoring...")
    _gpt2_model = GPT2LMHeadModel.from_pretrained("openai-community/gpt2")
    _gpt2_tokenizer = GPT2TokenizerFast.from_pretrained("openai-community/gpt2")
    _gpt2_model.eval()
    logger.info("GPT-2 loaded")
    return _gpt2_model, _gpt2_tokenizer


@dataclass
class PerplexityReport:
    available: bool = False
    sentence_perplexities: List[float] = field(default_factory=list)
    mean_perplexity: float = 0.0
    std_perplexity: float = 0.0
    cv_perplexity: float = 0.0  # coefficient of variation
    min_perplexity: float = 0.0
    max_perplexity: float = 0.0
    score: float = 0.0  # 0 = uniformly predictable/AI, 1 = varied/human

    def to_dict(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "sentence_perplexities": [round(p, 2) for p in self.sentence_perplexities],
            "mean_perplexity": round(self.mean_perplexity, 2),
            "std_perplexity": round(self.std_perplexity, 2),
            "cv_perplexity": round(self.cv_perplexity, 3),
            "min_perplexity": round(self.min_perplexity, 2),
            "max_perplexity": round(self.max_perplexity, 2),
            "score": round(self.score, 3),
        }


def _sentence_perplexity(text: str) -> Optional[float]:
    """Compute perplexity of a single sentence using GPT-2."""
    model, tokenizer = _load_gpt2()
    if model is None:
        return None
    try:
        import torch
    except ImportError:
        return None

    encodings = tokenizer(text, return_tensors="pt", truncation=True, max_length=1024)
    input_ids = encodings.input_ids
    if input_ids.size(1) < 2:
        return None

    with torch.no_grad():
        outputs = model(input_ids, labels=input_ids)
        loss = outputs.loss

    return math.exp(loss.item())


def compute_perplexity(text: str) -> PerplexityReport:
    """Compute per-sentence perplexity using GPT-2."""
    report = PerplexityReport()
    model, tokenizer = _load_gpt2()
    if model is None:
        return report

    sentences = split_sentences(text)
    if len(sentences) < 3:
        return report

    ppls = []
    for s in sentences:
        ppl = _sentence_perplexity(s)
        if ppl is not None and not math.isinf(ppl) and ppl < 50000:
            ppls.append(ppl)

    if len(ppls) < 3:
        return report

    report.available = True
    report.sentence_perplexities = ppls
    report.mean_perplexity = statistics.mean(ppls)
    report.std_perplexity = statistics.stdev(ppls)
    report.cv_perplexity = report.std_perplexity / report.mean_perplexity if report.mean_perplexity > 0 else 0
    report.min_perplexity = min(ppls)
    report.max_perplexity = max(ppls)

    # Scoring: human text has higher mean AND higher variance.
    # GPT-2 perplexity on human text: mean ~60-150, CV ~0.5-1.0
    # GPT-2 perplexity on AI text: mean ~20-50, CV ~0.2-0.4
    mean_score = min((report.mean_perplexity - 20) / 100, 1.0)
    cv_score = min(report.cv_perplexity / 0.7, 1.0)
    report.score = max(0, min(1, mean_score * 0.5 + cv_score * 0.5))

    return report


# ---------------------------------------------------------------------------
# Layer 3: Sapling AI Detector (optional, API key required)
# ---------------------------------------------------------------------------

@dataclass
class SaplingReport:
    available: bool = False
    overall_score: float = 0.0  # 0 = human, 1 = AI
    sentence_scores: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "available": self.available,
            "overall_score": round(self.overall_score, 4),
            "sentence_scores": self.sentence_scores,
        }
        if self.error:
            d["error"] = self.error
        return d


async def query_sapling(text: str, api_key: str) -> SaplingReport:
    """Query Sapling AI detector. Free tier: 50K chars/day."""
    import httpx

    report = SaplingReport()
    if not api_key:
        report.error = "no API key"
        return report

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://api.sapling.ai/api/v1/aidetect",
                json={
                    "key": api_key,
                    "text": text,
                    "sent_scores": True,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        report.available = True
        report.overall_score = data.get("score", 0)
        raw_sentences = data.get("sentence_scores", [])
        report.sentence_scores = [
            {"score": round(s.get("score", s[0]) if isinstance(s, dict) else s[0], 4),
             "sentence": s.get("sentence", s[1]) if isinstance(s, dict) else s[1]}
            for s in raw_sentences
            if (isinstance(s, (list, tuple)) and len(s) >= 2) or isinstance(s, dict)
        ]
    except Exception as e:
        report.error = str(e)
        logger.warning("Sapling API error: %s", e)

    return report


# ---------------------------------------------------------------------------
# Combined detection report
# ---------------------------------------------------------------------------

@dataclass
class DetectionReport:
    burstiness: BurstinessReport = field(default_factory=BurstinessReport)
    perplexity: PerplexityReport = field(default_factory=PerplexityReport)
    vocab: VocabReport = field(default_factory=VocabReport)
    sentence_start_diversity: float = 0.5
    ai_phrases: List[AIPhraseMatch] = field(default_factory=list)
    sapling: SaplingReport = field(default_factory=SaplingReport)
    risk_score: float = 0.0  # 0 = likely human, 1 = likely AI
    risk_label: str = "unknown"  # "low", "medium", "high"
    weak_spots: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "burstiness": self.burstiness.to_dict(),
            "perplexity": self.perplexity.to_dict(),
            "vocab": self.vocab.to_dict(),
            "sentence_start_diversity": round(self.sentence_start_diversity, 3),
            "ai_phrases": [m.to_dict() for m in self.ai_phrases],
            "sapling": self.sapling.to_dict(),
            "risk_score": round(self.risk_score, 3),
            "risk_label": self.risk_label,
            "weak_spots": self.weak_spots,
        }


def _identify_weak_spots(report: DetectionReport) -> List[str]:
    """Turn scores into specific, actionable weak-spot descriptions."""
    spots = []
    b = report.burstiness

    if b.sent_cv < 0.3:
        spots.append(
            f"Sentence lengths are too uniform (CV={b.sent_cv:.2f}, target >0.45). "
            f"Mix very short (3-6 word) sentences with long (25-40 word) ones."
        )
    if b.short_sentence_ratio < 0.05:
        spots.append(
            "No short punchy sentences. Add 2-3 sentences of 8 words or fewer."
        )
    if b.long_sentence_ratio < 0.05:
        spots.append(
            "No long complex sentences. Add 1-2 sentences of 30+ words with "
            "subordinate clauses or embedded detail."
        )
    if b.max_consecutive_similar > 4:
        spots.append(
            f"{b.max_consecutive_similar} consecutive sentences have similar length. "
            f"Break up the rhythm with a drastically shorter or longer sentence."
        )

    if report.ai_phrases:
        by_cat: Dict[str, List[str]] = {}
        for m in report.ai_phrases:
            by_cat.setdefault(m.category, []).append(m.phrase)
        for cat, phrases in by_cat.items():
            unique = list(dict.fromkeys(phrases))[:5]
            spots.append(
                f"AI-tell {cat} phrases detected: {', '.join(repr(p) for p in unique)}. "
                f"Replace or rephrase."
            )

    if report.vocab.score < 0.4:
        spots.append(
            f"Vocabulary diversity is low (TTR={report.vocab.type_token_ratio:.3f}). "
            f"Use more varied, less common words."
        )

    if report.sentence_start_diversity < 0.6:
        spots.append(
            f"Sentence openings repeat too much (diversity={report.sentence_start_diversity:.2f}). "
            f"Vary first words — start with prepositions, gerunds, subordinate clauses, objects."
        )

    if report.perplexity.available:
        p = report.perplexity
        if p.mean_perplexity < 40:
            spots.append(
                f"Text is very predictable to GPT-2 (mean perplexity={p.mean_perplexity:.0f}, "
                f"target >60). Use less expected word choices and phrasing."
            )
        if p.cv_perplexity < 0.3:
            spots.append(
                f"Perplexity is too uniform across sentences (CV={p.cv_perplexity:.2f}, "
                f"target >0.5). Some sentences should be surprising, others predictable."
            )

    if report.sapling.available:
        s = report.sapling
        if s.overall_score > 0.5:
            flagged = [ss for ss in s.sentence_scores if ss.get("score", 0) > 0.7]
            if flagged:
                spots.append(
                    f"Sapling flags {len(flagged)} sentences as likely AI (score >0.7). "
                    f"These need the most rewriting."
                )
            else:
                spots.append(
                    f"Sapling overall AI score: {s.overall_score:.0%}. "
                    f"General rewriting needed to break model fingerprints."
                )

    return spots


async def full_analysis(
    text: str,
    sapling_api_key: str = "",
    skip_perplexity: bool = False,
    skip_sapling: bool = False,
) -> DetectionReport:
    """Run all available detection layers and combine into a single report."""
    report = DetectionReport()

    # Layer 1: always available
    report.burstiness = compute_burstiness(text)
    report.ai_phrases = detect_ai_phrases(text)
    report.vocab = compute_vocab_diversity(text)
    report.sentence_start_diversity = compute_sentence_start_diversity(text)

    # Layer 2: optional perplexity
    if not skip_perplexity:
        report.perplexity = compute_perplexity(text)

    # Layer 3: optional Sapling
    if not skip_sapling and sapling_api_key:
        report.sapling = await query_sapling(text, sapling_api_key)

    # Combine into risk score. Weight available layers.
    scores = []
    weights = []

    # Burstiness (inverted — higher burstiness = lower risk)
    scores.append(1.0 - report.burstiness.score)
    weights.append(0.25)

    # AI phrases (more phrases = higher risk)
    phrase_penalty = min(len(report.ai_phrases) / 8, 1.0)
    scores.append(phrase_penalty)
    weights.append(0.15)

    # Vocab diversity (inverted)
    scores.append(1.0 - report.vocab.score)
    weights.append(0.10)

    # Sentence start diversity (inverted)
    scores.append(1.0 - report.sentence_start_diversity)
    weights.append(0.05)

    if report.perplexity.available:
        scores.append(1.0 - report.perplexity.score)
        weights.append(0.20)

    if report.sapling.available:
        scores.append(report.sapling.overall_score)
        weights.append(0.25)

    total_weight = sum(weights)
    report.risk_score = sum(s * w for s, w in zip(scores, weights)) / total_weight

    if report.risk_score < 0.3:
        report.risk_label = "low"
    elif report.risk_score < 0.6:
        report.risk_label = "medium"
    else:
        report.risk_label = "high"

    report.weak_spots = _identify_weak_spots(report)

    return report
