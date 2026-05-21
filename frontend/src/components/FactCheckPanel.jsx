import { useState } from 'react';
import './FactCheckPanel.css';

/**
 * FactCheckPanel — surfaces fact-check flags from the post-Stage-3
 * verification pass. Renders only when the backend's fact_check_essay
 * returned at least one flag (or while the check is still running, in
 * which case it shows a "checking…" affordance).
 *
 * Each flag has:
 *   quote   — exact substring of the essay that contains the problem
 *   status  — "contradicts" | "unsupported"
 *   note    — one-sentence explanation
 *
 * User can dismiss individual flags (hides them locally for this view
 * only — the persisted flags in conversation metadata stay intact).
 */
export default function FactCheckPanel({ flags, running }) {
    const [dismissed, setDismissed] = useState(new Set());

    const visibleFlags = (Array.isArray(flags) ? flags : []).filter(
        (_, i) => !dismissed.has(i)
    );

    if (running) {
        return (
            <div className="fact-check-panel fact-check-panel--running">
                <div className="fact-check-head">
                    <span className="fact-check-pulse" aria-hidden="true" />
                    <span className="fact-check-title">Fact-checking against what we know…</span>
                </div>
            </div>
        );
    }

    if (!visibleFlags.length) return null;

    const dismiss = (idx) => {
        setDismissed((prev) => {
            const next = new Set(prev);
            next.add(idx);
            return next;
        });
    };

    return (
        <aside
            className="fact-check-panel"
            aria-label="Fact-check flags"
        >
            <div className="fact-check-head">
                <span className="fact-check-icon" aria-hidden="true">!</span>
                <span className="fact-check-title">
                    {visibleFlags.length} {visibleFlags.length === 1 ? 'claim' : 'claims'} worth a second look
                </span>
            </div>
            <p className="fact-check-intro">
                Fix what's wrong, dismiss what's fine.
            </p>
            <ul className="fact-check-list">
                {(flags || []).map((flag, idx) => {
                    if (dismissed.has(idx)) return null;
                    const status = flag.status || 'unsupported';
                    return (
                        <li
                            key={idx}
                            className={`fact-check-flag fact-check-flag--${status}`}
                        >
                            <div className="fact-check-flag-head">
                                <span className={`fact-check-tag fact-check-tag--${status}`}>
                                    {status === 'contradicts' ? 'Contradicts' : 'Unsupported'}
                                </span>
                                <button
                                    type="button"
                                    className="fact-check-dismiss"
                                    onClick={() => dismiss(idx)}
                                    title="Hide this flag — won't affect the essay"
                                >
                                    Dismiss
                                </button>
                            </div>
                            <blockquote className="fact-check-quote">
                                "{flag.quote}"
                            </blockquote>
                            <div className="fact-check-note">{flag.note}</div>
                        </li>
                    );
                })}
            </ul>
        </aside>
    );
}
