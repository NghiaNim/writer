import './CouncilDecisions.css';

/**
 * Two small read-only surfaces rendered inside the FinalEssay "Show council
 * notes" disclosure so the user can see WHY this essay turned out the way
 * it did:
 *
 *   <PitchSummary>   — the 4 angle pitches with the winner highlighted
 *   <SpinePick>      — which Stage 1 draft was picked as the spine
 *
 * Both are no-ops if their data isn't on the message (older essays
 * generated before the 0.4.0 pipeline rewrite).
 */

function getShortPersona(name, model) {
    if (name && name.trim()) return name.trim();
    if (!model) return 'Unknown';
    if (model.includes('/')) return model.split('/').pop();
    if (model.includes(':')) return model.split(':').pop();
    return model;
}

export function PitchSummary({ pitches, pickedPitch }) {
    if (!Array.isArray(pitches) || pitches.length === 0) return null;
    const winnerIndex =
        typeof pickedPitch?.winner_index === 'number' ? pickedPitch.winner_index : -1;
    const winnerReason = (pickedPitch?.reason || '').trim();

    return (
        <section className="council-decisions__section">
            <header className="council-decisions__head">
                <span className="council-decisions__title">Council pitches</span>
                <span className="council-decisions__hint">
                    {pitches.length} angles considered. The picked one becomes the
                    shared thesis every draft writes toward.
                </span>
            </header>
            <ul className="council-decisions__pitches">
                {pitches.map((p, i) => {
                    const isWinner = i === winnerIndex && !p?.error;
                    const persona = getShortPersona(p?.persona, p?.model);
                    const text = (p?.response || '').trim();
                    return (
                        <li
                            key={i}
                            className={`council-decisions__pitch ${
                                isWinner ? 'council-decisions__pitch--picked' : ''
                            } ${p?.error ? 'council-decisions__pitch--error' : ''}`}
                        >
                            <div className="council-decisions__pitch-head">
                                <span className="council-decisions__pitch-persona">
                                    {persona}
                                </span>
                                {isWinner && (
                                    <span className="council-decisions__badge">
                                        Picked
                                    </span>
                                )}
                            </div>
                            {p?.error ? (
                                <div className="council-decisions__pitch-error">
                                    {p?.error_message || 'Pitch failed.'}
                                </div>
                            ) : (
                                <pre className="council-decisions__pitch-body">{text}</pre>
                            )}
                        </li>
                    );
                })}
            </ul>
            {winnerReason && (
                <div className="council-decisions__reason">
                    <span className="council-decisions__reason-label">
                        Why this one:
                    </span>{' '}
                    <span>{winnerReason}</span>
                </div>
            )}
        </section>
    );
}

export function SpinePick({ pickedSpine }) {
    if (!pickedSpine || typeof pickedSpine.winner_index !== 'number') return null;
    const persona = getShortPersona(pickedSpine.persona, pickedSpine.model);
    const reason = (pickedSpine.reason || '').trim();
    return (
        <section className="council-decisions__section">
            <header className="council-decisions__head">
                <span className="council-decisions__title">Spine pick</span>
                <span className="council-decisions__hint">
                    The chairman revised this draft using the council's critiques.
                </span>
            </header>
            <div className="council-decisions__spine">
                <div className="council-decisions__spine-row">
                    <span className="council-decisions__pitch-persona">{persona}</span>
                    <span className="council-decisions__badge">Spine</span>
                </div>
                {reason && (
                    <div className="council-decisions__reason">
                        <span className="council-decisions__reason-label">
                            Why this one:
                        </span>{' '}
                        <span>{reason}</span>
                    </div>
                )}
            </div>
        </section>
    );
}
