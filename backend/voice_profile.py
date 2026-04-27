"""Voice profile storage and prompt-block rendering (Phase 2).

The voice profile is the user's personal style. It is loaded from
`data/voice_profile.json` and injected into the Voice Guardian's Stage 1
prompt and the Chairman's Stage 3 synthesis prompt via the
`{voice_profile_block}` template variable.

When the profile is empty, the rendered block is an empty string and the
default "no profile yet" fallback inside the persona / chairman templates
takes over.
"""

import json
from pathlib import Path
from typing import List

from pydantic import BaseModel

# Where the profile lives on disk (sibling of data/settings.json)
VOICE_PROFILE_FILE = Path(__file__).parent.parent / "data" / "voice_profile.json"


class VoiceProfile(BaseModel):
    """User-defined writing voice."""

    rules: List[str] = []
    reference_paragraphs: List[str] = []
    inferred_style: str = ""


def get_voice_profile() -> VoiceProfile:
    """Load the voice profile from disk, returning an empty profile if missing or invalid."""
    if VOICE_PROFILE_FILE.exists():
        try:
            with open(VOICE_PROFILE_FILE, "r") as f:
                data = json.load(f)
                return VoiceProfile(**data)
        except Exception:
            # Corrupt file should not crash the council run; fall through to empty.
            pass
    return VoiceProfile()


def save_voice_profile(profile: VoiceProfile) -> VoiceProfile:
    """Persist the voice profile, creating the data directory if needed."""
    VOICE_PROFILE_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Light normalization: strip whitespace, drop empty entries
    cleaned = VoiceProfile(
        rules=[r.strip() for r in profile.rules if r and r.strip()],
        reference_paragraphs=[
            p.strip() for p in profile.reference_paragraphs if p and p.strip()
        ],
        inferred_style=(profile.inferred_style or "").strip(),
    )

    with open(VOICE_PROFILE_FILE, "w") as f:
        json.dump(cleaned.model_dump(), f, indent=2)
    return cleaned


def has_content(profile: VoiceProfile) -> bool:
    """True if the profile has any rules, reference paragraphs, or inferred style."""
    return bool(
        profile.rules
        or profile.reference_paragraphs
        or (profile.inferred_style and profile.inferred_style.strip())
    )


def format_voice_profile_block(profile: VoiceProfile = None) -> str:
    """Render the profile as a prompt-friendly block.

    Returns an empty string when the profile has no content, so prompt
    templates can include `{voice_profile_block}` unconditionally without
    polluting the output for users who haven't set a profile yet.
    """
    if profile is None:
        profile = get_voice_profile()

    if not has_content(profile):
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

    sections.append("")  # trailing newline so the block separates cleanly
    return "\n".join(sections)
