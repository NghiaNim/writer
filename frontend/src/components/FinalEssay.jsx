import { useState } from 'react';
import ThinkBlockRenderer from './ThinkBlockRenderer';
import { getModelVisuals, getShortModelName } from '../utils/modelHelpers';
import StageTimer from './StageTimer';
import './FinalEssay.css';

/**
 * Phase 3 essay-optimized presentation: shows the chairman's final essay
 * full-width, with copy / regenerate actions and a collapsed-by-default
 * "Show council notes" toggle that reveals Stages 1 & 2 (passed in as
 * `councilNotes`).
 */
export default function FinalEssay({
    finalResponse,
    startTime,
    endTime,
    councilNotes,
    onRegenerate,
    canRegenerate = false,
}) {
    const [isCopied, setIsCopied] = useState(false);
    const [showNotes, setShowNotes] = useState(false);

    if (!finalResponse) return null;

    const visuals = getModelVisuals(finalResponse?.model);
    const shortName = getShortModelName(finalResponse?.model);

    const essayText =
        typeof finalResponse?.response === 'string'
            ? finalResponse.response
            : String(finalResponse?.response || '');

    const handleCopy = async () => {
        if (!essayText) return;
        try {
            await navigator.clipboard.writeText(essayText);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy essay:', err);
        }
    };

    return (
        <div className="final-essay">
            <div className="final-essay-meta">
                <div className="final-essay-byline">
                    <span className="byline-label">Final essay</span>
                    <span className="byline-sep">·</span>
                    <span className="byline-model">
                        synthesized by <strong>{shortName}</strong>
                        <span className="byline-provider">{visuals.name}</span>
                    </span>
                </div>
                <StageTimer startTime={startTime} endTime={endTime} label="Council time" />
            </div>

            <article className="final-essay-body markdown-content">
                <ThinkBlockRenderer content={essayText || 'No response'} />
            </article>

            <div className="final-essay-actions">
                <button
                    type="button"
                    className={`essay-action-btn ${isCopied ? 'copied' : ''}`}
                    onClick={handleCopy}
                    title="Copy essay to clipboard"
                >
                    {isCopied ? (
                        <>
                            <span className="essay-action-icon">✓</span>
                            <span>Copied</span>
                        </>
                    ) : (
                        <>
                            <span className="essay-action-icon">📋</span>
                            <span>Copy</span>
                        </>
                    )}
                </button>
                {canRegenerate && (
                    <button
                        type="button"
                        className="essay-action-btn"
                        onClick={onRegenerate}
                        title="Regenerate the essay with the same prompt"
                    >
                        <span className="essay-action-icon">↻</span>
                        <span>Regenerate</span>
                    </button>
                )}
                {councilNotes && (
                    <button
                        type="button"
                        className={`essay-action-btn essay-toggle-notes ${showNotes ? 'active' : ''}`}
                        onClick={() => setShowNotes((v) => !v)}
                        aria-expanded={showNotes}
                    >
                        <span className="essay-action-icon">{showNotes ? '▾' : '▸'}</span>
                        <span>{showNotes ? 'Hide council notes' : 'Show council notes'}</span>
                    </button>
                )}
            </div>

            {showNotes && councilNotes && (
                <div className="final-essay-council-notes">
                    <div className="council-notes-intro">
                        How the council got here — individual drafts, then anonymous peer
                        rankings.
                    </div>
                    {councilNotes}
                </div>
            )}
        </div>
    );
}
