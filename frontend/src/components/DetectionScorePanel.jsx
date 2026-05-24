import { useState, useCallback } from 'react';
import { api } from '../api';
import './DetectionScorePanel.css';

/**
 * DetectionScorePanel — surfaces AI detection risk analysis from the
 * post-Stage-3 scoring pass. Renders between FactCheckPanel and the
 * actions row.
 *
 * Shows risk score, burstiness, AI-phrase count, and specific weak spots.
 * Offers an "Optimize" button that runs the score→revise→score loop and
 * streams back an improved essay.
 */
export default function DetectionScorePanel({
    score,
    running,
    essayText,
    onOptimizedEssay,
}) {
    const [expanded, setExpanded] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [optimizeProgress, setOptimizeProgress] = useState(null);

    const handleOptimize = useCallback(async () => {
        if (!essayText || optimizing) return;
        setOptimizing(true);
        setOptimizeProgress({ status: 'starting', iteration: 0 });

        try {
            const response = await api.streamDetectionOptimize(essayText);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        switch (event.type) {
                            case 'scoring_start':
                                setOptimizeProgress({
                                    status: 'scoring',
                                    iteration: event.data.iteration,
                                });
                                break;
                            case 'scoring_complete':
                                setOptimizeProgress({
                                    status: 'scored',
                                    iteration: event.data.iteration,
                                    riskScore: event.data.risk_score,
                                    riskLabel: event.data.risk_label,
                                });
                                break;
                            case 'revising_start':
                                setOptimizeProgress({
                                    status: 'revising',
                                    iteration: event.data.iteration,
                                    model: event.data.model,
                                });
                                break;
                            case 'revising_complete':
                                setOptimizeProgress({
                                    status: 'revised',
                                    iteration: event.data.iteration,
                                });
                                break;
                            case 'converged':
                            case 'optimize_complete':
                                if (event.data.essay && onOptimizedEssay) {
                                    onOptimizedEssay(event.data.essay);
                                }
                                setOptimizeProgress({
                                    status: 'done',
                                    riskScore: event.data.risk_score || event.data.report?.risk_score,
                                    riskLabel: event.data.risk_label || event.data.report?.risk_label,
                                });
                                break;
                            case 'revision_failed':
                            case 'revision_error':
                                setOptimizeProgress({
                                    status: 'error',
                                    error: event.data.reason || event.data.error,
                                });
                                break;
                        }
                    } catch {
                        // skip malformed SSE lines
                    }
                }
            }
        } catch (err) {
            setOptimizeProgress({ status: 'error', error: err.message });
        } finally {
            setOptimizing(false);
        }
    }, [essayText, optimizing, onOptimizedEssay]);

    if (running) {
        return (
            <div className="detection-panel detection-panel--running">
                <div className="detection-head">
                    <span className="detection-pulse" aria-hidden="true" />
                    <span className="detection-title">Scoring for AI detection risk…</span>
                </div>
            </div>
        );
    }

    if (!score) return null;

    const { risk_score, risk_label, weak_spots, burstiness, ai_phrases, vocab, sapling } = score;
    const riskPct = Math.round(risk_score * 100);
    const hasWeakSpots = weak_spots && weak_spots.length > 0;

    return (
        <aside className={`detection-panel detection-panel--${risk_label}`} aria-label="AI detection risk">
            <div className="detection-head">
                <div className="detection-head-left">
                    <span className={`detection-badge detection-badge--${risk_label}`}>
                        {risk_label}
                    </span>
                    <span className="detection-title">
                        Detection risk: {riskPct}%
                    </span>
                </div>
                {hasWeakSpots && (
                    <button
                        type="button"
                        className="detection-expand"
                        onClick={() => setExpanded(v => !v)}
                        aria-expanded={expanded}
                    >
                        {expanded ? 'Hide details' : `${weak_spots.length} weak spots`}
                    </button>
                )}
            </div>

            <div className="detection-meters">
                <Meter label="Burstiness" value={burstiness?.score} good="high" />
                <Meter label="Vocab diversity" value={vocab?.score} good="high" />
                <Meter
                    label="AI phrases"
                    value={ai_phrases?.length > 0 ? Math.max(0, 1 - ai_phrases.length / 10) : 1}
                    good="high"
                    rawLabel={`${ai_phrases?.length || 0} found`}
                />
                {sapling?.available && (
                    <Meter
                        label="Sapling"
                        value={1 - (sapling.overall_score || 0)}
                        good="high"
                        rawLabel={`${Math.round((1 - sapling.overall_score) * 100)}% human`}
                    />
                )}
            </div>

            {expanded && hasWeakSpots && (
                <ul className="detection-weak-spots">
                    {weak_spots.map((ws, i) => (
                        <li key={i} className="detection-weak-spot">{ws}</li>
                    ))}
                </ul>
            )}

            {hasWeakSpots && (
                <div className="detection-actions">
                    <button
                        type="button"
                        className="detection-optimize-btn"
                        onClick={handleOptimize}
                        disabled={optimizing}
                    >
                        {optimizing ? 'Optimizing…' : 'Optimize to beat detectors'}
                    </button>
                    {optimizeProgress && (
                        <span className="detection-optimize-status">
                            {formatProgress(optimizeProgress)}
                        </span>
                    )}
                </div>
            )}

            {optimizeProgress?.status === 'done' && (
                <div className="detection-result">
                    <span className={`detection-badge detection-badge--${optimizeProgress.riskLabel || 'low'}`}>
                        {optimizeProgress.riskLabel || 'low'}
                    </span>
                    <span>
                        Optimized risk: {Math.round((optimizeProgress.riskScore || 0) * 100)}%
                    </span>
                </div>
            )}
        </aside>
    );
}


function Meter({ label, value, rawLabel }) {
    const pct = Math.round((value || 0) * 100);
    const color = pct >= 70 ? 'var(--detection-good)' : pct >= 40 ? 'var(--detection-warn)' : 'var(--detection-bad)';
    return (
        <div className="detection-meter">
            <div className="detection-meter-label">
                <span>{label}</span>
                <span className="detection-meter-value">{rawLabel || `${pct}%`}</span>
            </div>
            <div className="detection-meter-track">
                <div
                    className="detection-meter-fill"
                    style={{ width: `${pct}%`, background: color }}
                />
            </div>
        </div>
    );
}


function formatProgress(p) {
    switch (p.status) {
        case 'starting': return 'Starting optimization…';
        case 'scoring': return `Scoring iteration ${p.iteration + 1}…`;
        case 'scored': return `Risk: ${Math.round(p.riskScore * 100)}% (${p.riskLabel})`;
        case 'revising': return `Revising (iteration ${p.iteration + 1})…`;
        case 'revised': return `Revision ${p.iteration + 1} complete`;
        case 'done': return 'Optimization complete';
        case 'error': return `Error: ${p.error}`;
        default: return '';
    }
}
