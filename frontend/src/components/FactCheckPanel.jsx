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
 * Per-flag actions:
 *   - Fix this: pre-fills the refinement dock with a structured instruction
 *     pinned to the quote so the user can send a one-click rewrite to
 *     the council. The flag is marked "fixing…" while the refinement
 *     runs; ChatInterface drops it from `dismissedExternal` once a new
 *     draft lands.
 *   - Dismiss: hides the flag locally for this view (persisted flags
 *     in conversation metadata stay intact).
 */
export default function FactCheckPanel({
    flags,
    running,
    onFixFlag,
    fixingFlagIdx = null,
    // External dismissal set — ChatInterface owns this so flags can be
    // hidden across re-renders (e.g. when an auto-fix completes). Falls
    // back to internal local-only dismissal when not provided.
    dismissedFlags,
    onDismissFlag,
}) {
    const [internalDismissed, setInternalDismissed] = useState(new Set());

    // Prefer the externally-managed dismissal set when provided.
    const dismissed = dismissedFlags || internalDismissed;
    const setDismissed = (next) => {
        if (onDismissFlag) {
            // External owner handles the update; nothing for us to do
            // beyond firing the callback in `dismiss` below.
            return;
        }
        setInternalDismissed(next);
    };

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
        if (onDismissFlag) {
            onDismissFlag(idx);
        } else {
            setInternalDismissed((prev) => {
                const next = new Set(prev);
                next.add(idx);
                return next;
            });
        }
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
                    const isFixing = fixingFlagIdx === idx;
                    return (
                        <li
                            key={idx}
                            className={
                                `fact-check-flag fact-check-flag--${status}` +
                                (isFixing ? ' fact-check-flag--fixing' : '')
                            }
                        >
                            <div className="fact-check-flag-head">
                                <span className={`fact-check-tag fact-check-tag--${status}`}>
                                    {status === 'contradicts' ? 'Contradicts' : 'Unsupported'}
                                </span>
                                <div className="fact-check-flag-actions">
                                    {onFixFlag && (
                                        <button
                                            type="button"
                                            className="fact-check-fix"
                                            onClick={() => onFixFlag(flag, idx)}
                                            disabled={isFixing}
                                            title="Send this to the council to rewrite the flagged passage"
                                        >
                                            {isFixing ? 'Fixing…' : 'Fix this'}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="fact-check-dismiss"
                                        onClick={() => dismiss(idx)}
                                        disabled={isFixing}
                                        title="Hide this flag — won't affect the essay"
                                    >
                                        Dismiss
                                    </button>
                                </div>
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
