import { useEffect, useMemo, useState } from 'react';
import './EssayLoadingStatus.css';

// Brewing-room copy for the loading panel. The mapping mirrors a specialty-
// coffee prep flow:
//
//   search  →  sourcing (where the beans come from)
//   pitch   →  grinding (preparing the angles, each persona dials a setting)
//   stage1  →  pulling shots (4 parallel extractions)
//   stage2  →  tasting / cupping (judging the strongest shot)
//   stage3  →  the pour (finishing into the cup)
//
// Reference: James Hoffmann's "World Atlas of Coffee" + r/espresso prep
// vocabulary. The bloom we render in CSS is the 30s CO2 pre-infusion in
// pour-over technique — a real phenomenon when fresh-ground coffee meets
// water for the first time.
const MESSAGES = {
    search: [
        'sourcing beans from the wider web...',
        'checking origin notes before we grind...',
        'reading the room before we dial in...',
    ],
    pitch: [
        'four baristas dial in their grind in parallel...',
        'the architect goes coarse — a slow, structural pull...',
        'the devil\'s advocate goes fine — sharp, against the grain...',
        'the voice guardian opens with one concrete tasting note...',
        'cupping the pitches; picking the cleanest cup...',
    ],
    stage1: [
        'four shots pulling in parallel from the same dial-in...',
        'the architect is pulling long; load-bearing crema...',
        'the editor cuts the channel and pulls short and clean...',
        'the devil\'s advocate pulls against the grain on purpose...',
        'the voice guardian grounds paragraph one in a real cafe moment...',
    ],
    stage2: [
        'cupping the strongest shot against the rest...',
        'noting the over-extraction, the under-extraction, what to keep...',
        'pulling sharper notes from the runner-up shots...',
    ],
    stage3: [
        'chairman is finishing the pour...',
        'cutting the bitter notes the cuppers flagged...',
        'pulling the sweetness forward...',
        'protecting the body the cuppers asked us to keep...',
        'final pass through the voice rules before serving...',
    ],
    idle: ['cafe is open; standing by the machine...'],
};

function pickStage({ loading, msg }) {
    if (!loading) return 'idle';
    // Live loading flag wins when set.
    if (loading.stage3) return 'stage3';
    if (loading.stage2) return 'stage2';
    if (loading.stage1) return 'stage1';
    if (loading.pitch) return 'pitch';
    if (loading.search) return 'search';
    // Between SSE phases every flag is false — fall back to the highest
    // stage we've already finished so the panel doesn't read "idle" while
    // the chairman waits for a clarification answer.
    if (msg?.stage2) return 'stage3';
    if (msg?.stage1) return 'stage2';
    if (msg?.pitches?.length) return 'stage1';
    return 'idle';
}

function describeStage(stage) {
    switch (stage) {
        case 'search':
            return 'Sourcing';
        case 'pitch':
            return 'Grinding';
        case 'stage1':
            return 'Pulling shots';
        case 'stage2':
            return 'Cupping';
        case 'stage3':
            return 'The pour';
        default:
            return 'At the bar';
    }
}

/**
 * Terminal-style "the council is working" panel shown in place of the raw
 * deliberation while an essay is being generated.
 *
 * `onAbort` is the stop-this-stream callback. When provided, the panel
 * renders a visible Stop button in its top bar — previously this control
 * only existed in the sidebar conversation row, which the user's eye
 * rarely lands on during the 60-90s wait.
 */
export default function EssayLoadingStatus({ loading, progress, aborted, onAbort, msg }) {
    const stage = pickStage({ loading, msg });
    const messages = useMemo(() => MESSAGES[stage] || MESSAGES.idle, [stage]);
    const [messageIdx, setMessageIdx] = useState(0);
    const [minimized, setMinimized] = useState(false);

    useEffect(() => {
        // Reset to first message whenever the stage changes
        setMessageIdx(0);
    }, [stage]);

    useEffect(() => {
        if (messages.length <= 1) return undefined;
        const id = setInterval(() => {
            setMessageIdx((i) => (i + 1) % messages.length);
        }, 2400);
        return () => clearInterval(id);
    }, [messages]);

    const stageLabel = describeStage(stage);
    const pitchProgress = progress?.pitch;
    const stage1Progress = progress?.stage1;
    const stage2Progress = progress?.stage2;

    let progressLabel = null;
    if (stage === 'pitch' && pitchProgress?.total) {
        progressLabel = `${pitchProgress.count} of ${pitchProgress.total} dialed in`;
    } else if (stage === 'stage1' && stage1Progress?.total) {
        progressLabel = `${stage1Progress.count} of ${stage1Progress.total} shots pulled`;
    } else if (stage === 'stage2' && stage2Progress?.total) {
        const noun = stage2Progress.total === 1 ? 'cup tasted' : 'cups tasted';
        progressLabel = `${stage2Progress.count} of ${stage2Progress.total} ${noun}`;
    }

    if (minimized) {
        return (
            <div className={`essay-loading-status essay-loading-status--compact ${aborted ? 'aborted' : ''}`}>
                <button
                    type="button"
                    className="essay-loading-compact-inner"
                    onClick={() => setMinimized(false)}
                    aria-expanded={false}
                    title="Expand progress details"
                >
                    <span className="essay-loading-dot" aria-hidden="true" />
                    <span className="essay-loading-stage">{stageLabel}</span>
                    {progressLabel && (
                        <span className="essay-loading-progress">{progressLabel}</span>
                    )}
                    <span className="essay-loading-compact-msg">{messages[messageIdx]}</span>
                    <span className="essay-loading-expand-hint" aria-hidden="true">
                        ▼
                    </span>
                </button>
            </div>
        );
    }

    return (
        <div className={`essay-loading-status ${aborted ? 'aborted' : ''}`}>
            <div className="essay-loading-bar">
                <span className="essay-loading-dot" />
                <span className="essay-loading-stage">{stageLabel}</span>
                {progressLabel && (
                    <span className="essay-loading-progress">{progressLabel}</span>
                )}
                <div className="essay-loading-bar-actions">
                    {onAbort && !aborted && (
                        <button
                            type="button"
                            className="essay-loading-stop"
                            onClick={onAbort}
                            title="Stop this run"
                        >
                            <span className="essay-loading-stop-icon" aria-hidden="true">■</span>
                            Stop
                        </button>
                    )}
                    <button
                        type="button"
                        className="essay-loading-minimize"
                        onClick={() => setMinimized(true)}
                        aria-expanded={true}
                        title="Minimize"
                    >
                        Minimize
                    </button>
                </div>
            </div>
            <div className="essay-loading-line">
                <span className="essay-loading-prompt">&gt;</span>
                <span className="essay-loading-message">{messages[messageIdx]}</span>
                <span className="essay-loading-cursor" aria-hidden="true">_</span>
            </div>
            <div className="essay-loading-hint">
                Four shots pulling in parallel. ~90s.
            </div>
        </div>
    );
}
