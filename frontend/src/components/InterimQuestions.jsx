import { useEffect, useMemo, useRef, useState } from 'react';
import './InterimQuestions.css';

/**
 * One row in "Here's what the council heard". Renders the question line
 * as the title, then either:
 *   - the structured expansion (bullets + entity chips + inferred +
 *     related facts) if /api/intake/expand has returned for this entry, OR
 *   - a brief "listening…" placeholder while expansion is pending, OR
 *   - the verbatim answer as a fallback (expansion failed or wasn't run).
 */
function HeardItem({ entry }) {
    const expansion = entry?.expansion;
    const isLoading = !!entry?.expanding && !expansion;

    const bullets = Array.isArray(expansion?.bullets) ? expansion.bullets : [];
    const entities = Array.isArray(expansion?.entities) ? expansion.entities : [];
    const inferred = Array.isArray(expansion?.inferred) ? expansion.inferred : [];
    const relatedFacts = Array.isArray(expansion?.related_facts)
        ? expansion.related_facts
        : [];

    const hasStructure =
        bullets.length > 0 ||
        entities.length > 0 ||
        inferred.length > 0 ||
        relatedFacts.length > 0;

    return (
        <li className="interim-questions__heard-item">
            <span className="interim-questions__heard-q">{entry.question}</span>

            {expansion && hasStructure ? (
                <>
                    {bullets.length > 0 ? (
                        <ul className="interim-questions__heard-bullets">
                            {bullets.map((b, i) => (
                                <li key={i}>{b}</li>
                            ))}
                        </ul>
                    ) : (
                        <span className="interim-questions__heard-a">
                            {entry.answer}
                        </span>
                    )}

                    {entities.length > 0 && (
                        <div className="interim-questions__heard-entities">
                            {entities.map((e, i) => (
                                <span
                                    key={i}
                                    className={`heard-chip heard-chip--${e.type || 'other'}`}
                                    title={e.type || 'other'}
                                >
                                    {e.value}
                                </span>
                            ))}
                        </div>
                    )}

                    {inferred.length > 0 && (
                        <div className="interim-questions__heard-inferred">
                            <span className="heard-section-label">
                                The council inferred
                            </span>
                            <ul>
                                {inferred.map((line, i) => (
                                    <li key={i}>{line}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {relatedFacts.length > 0 && (
                        <div className="interim-questions__heard-related">
                            <span className="heard-section-label">
                                Building on what you've told us before
                            </span>
                            <ul>
                                {relatedFacts.map((f) => (
                                    <li key={f.id}>{f.fact_text}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            ) : isLoading ? (
                <span className="interim-questions__heard-loading">
                    Listening — the council is organizing what you just said…
                </span>
            ) : (
                <span className="interim-questions__heard-a">{entry.answer}</span>
            )}
        </li>
    );
}

/**
 * Side panel that appears alongside EssayLoadingStatus while the council is
 * working. Shows up to MAX_QUESTIONS_PER_RUN questions the backend asked,
 * one at a time, with a textarea + skip/submit. Answers are POSTed to
 * /api/intake/answer; the chairman reads them in stage 3 if they arrive in
 * time, and they get extracted into user_fact for next time regardless.
 */
export default function InterimQuestions({
    questions = [],
    onAnswer,
    runFinished = false,
    runFinishedReason = null,
}) {
    const list = Array.isArray(questions) ? questions : [];

    // Find the first pending question (questions arrive over time as SSE events).
    const activeIdx = useMemo(
        () => list.findIndex((q) => q.status === 'pending'),
        [list]
    );
    const total = list.length;
    const answered = list.filter((q) => q.status === 'submitted').length;
    const skipped = list.filter((q) => q.status === 'skipped').length;

    const [draft, setDraft] = useState('');
    const lastSeenIdRef = useRef(null);

    // Reset the textarea whenever a NEW question becomes active.
    useEffect(() => {
        const activeQ = activeIdx >= 0 ? list[activeIdx] : null;
        if (!activeQ) return;
        if (lastSeenIdRef.current !== activeQ.question_id) {
            lastSeenIdRef.current = activeQ.question_id;
            setDraft('');
        }
    }, [activeIdx, list]);

    if (total === 0) return null;

    const activeQ = activeIdx >= 0 ? list[activeIdx] : null;
    const heard = list.filter((q) => q.status === 'submitted' && q.answer);
    const isChairmanAsk = Boolean(activeQ?.chairmanAsk);

    const submit = () => {
        if (!activeQ || runFinished) return;
        const trimmed = (draft || '').trim();
        if (!trimmed) return;
        onAnswer?.({
            questionId: activeQ.question_id,
            question: activeQ.question,
            answer: trimmed,
            skipped: false,
        });
    };

    const skip = () => {
        if (!activeQ || runFinished) return;
        onAnswer?.({
            questionId: activeQ.question_id,
            question: activeQ.question,
            answer: '',
            skipped: true,
        });
    };

    const handleKey = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
        }
    };

    const lockedNote =
        runFinishedReason === 'aborted'
            ? 'Run cancelled — any new answers would only land in your next essay.'
            : runFinishedReason === 'error'
                ? 'Run errored out before this question could be folded in.'
                : 'Final essay is in — new answers can\'t change this draft.';

    return (
        <aside
            className={`interim-questions${isChairmanAsk ? ' interim-questions--chairman' : ''}`}
            aria-label="Questions from the council"
        >
            <div className="interim-questions__head">
                <span className="interim-questions__pulse" aria-hidden="true" />
                <span className="interim-questions__title">
                    {isChairmanAsk
                        ? 'The chairman wants to confirm one thing'
                        : 'While we draft…'}
                </span>
                <span className="interim-questions__count">
                    {answered + skipped} / {total}
                </span>
            </div>

            {activeQ ? (
                <>
                    {isChairmanAsk && !runFinished && (
                        <p className="interim-questions__chairman-note">
                            About to write your final essay. Your answer here
                            (or a quick skip) lands in the very next prompt.
                        </p>
                    )}
                    {runFinished && (
                        <p className="interim-questions__chairman-note">
                            {lockedNote}
                        </p>
                    )}
                    <p className="interim-questions__q">{activeQ.question}</p>
                    <textarea
                        className="interim-questions__input"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={handleKey}
                        placeholder="A sentence or two — anything specific helps."
                        rows={3}
                        disabled={runFinished}
                        readOnly={runFinished}
                    />
                    <div className="interim-questions__actions">
                        <button
                            type="button"
                            className="interim-questions__skip"
                            onClick={skip}
                            disabled={runFinished}
                        >
                            Skip
                        </button>
                        <button
                            type="button"
                            className="interim-questions__submit"
                            onClick={submit}
                            disabled={runFinished || !draft.trim()}
                            title={runFinished ? 'Run finished' : '⌘/Ctrl + Enter'}
                        >
                            {runFinished
                                ? 'Locked'
                                : isChairmanAsk
                                    ? 'Use in final essay'
                                    : 'Send to chairman'}
                        </button>
                    </div>
                </>
            ) : (
                <p className="interim-questions__done">
                    Thanks — we’ll fold these in. Final draft incoming.
                </p>
            )}

            {heard.length > 0 && (
                <div className="interim-questions__heard">
                    <div className="interim-questions__heard-title">
                        Here's what the council heard
                    </div>
                    <ul className="interim-questions__heard-list">
                        {heard.map((q) => (
                            <HeardItem key={q.question_id} entry={q} />
                        ))}
                    </ul>
                </div>
            )}

            {skipped > 0 && (
                <p className="interim-questions__skipped-note">
                    {skipped === 1 ? '1 question skipped' : `${skipped} questions skipped`}
                </p>
            )}

            <p className="interim-questions__tip">
                Tip: you can change which questions you're asked by editing your council
                in Settings → Council, or your voice rules in Settings → Voice.
            </p>
        </aside>
    );
}
