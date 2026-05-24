import { useState } from 'react';
import './FactCheckPanel.css';

/**
 * FactCheckPanel — surfaces fact-check flags from the post-Stage-3
 * verification pass. Each flag can be individually dismissed. A single
 * "Fix all" button sends all remaining flags to the council at once.
 */
export default function FactCheckPanel({
    flags,
    running,
    onFixAll,
    fixingAll = false,
    dismissedFlags,
    onDismissFlag,
}) {
    const [internalDismissed, setInternalDismissed] = useState(new Set());

    const dismissed = dismissedFlags || internalDismissed;

    const visibleFlags = (Array.isArray(flags) ? flags : []).map((f, i) => ({ ...f, _idx: i })).filter(
        (f) => !dismissed.has(f._idx)
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
                {onFixAll && visibleFlags.length > 0 && (
                    <button
                        type="button"
                        className="fact-check-fix-all"
                        onClick={() => onFixAll(visibleFlags)}
                        disabled={fixingAll}
                    >
                        {fixingAll ? 'Fixing…' : 'Fix all'}
                    </button>
                )}
            </div>
            <ul className="fact-check-list">
                {visibleFlags.map((flag) => {
                    const status = flag.status || 'unsupported';
                    return (
                        <li
                            key={flag._idx}
                            className={`fact-check-flag fact-check-flag--${status}`}
                        >
                            <div className="fact-check-flag-head">
                                <span className={`fact-check-tag fact-check-tag--${status}`}>
                                    {status === 'contradicts' ? 'Contradicts' : 'Unsupported'}
                                </span>
                                <button
                                    type="button"
                                    className="fact-check-dismiss"
                                    onClick={() => dismiss(flag._idx)}
                                    title="Dismiss — this claim is fine"
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
