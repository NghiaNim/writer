import { useEffect, useMemo, useState } from 'react';
import './EssayLoadingStatus.css';

const MESSAGES = {
    search: [
        'consulting the wider web...',
        'pulling sources for context...',
        'reading what the internet thinks...',
    ],
    pitch: [
        'council members are pitching angles in parallel...',
        'the architect is proposing a structural spine...',
        'the devil\'s advocate is pitching an inversion...',
        'the voice guardian is picking a concrete opening...',
        'picking the strongest pitch...',
    ],
    stage1: [
        'council members are drafting in parallel from the chosen angle...',
        'the architect is writing in long, load-bearing paragraphs...',
        'the editor is leaning into short paragraphs and white space...',
        'the devil\'s advocate is opening with the strongest counter...',
        'the voice guardian is grounding paragraph one in a real moment...',
    ],
    stage2: [
        'critiquing the strongest draft...',
        'flagging cuts, sharpens, and what to keep...',
        'pulling sharper sentences from the runner-up drafts...',
    ],
    stage3: [
        'chairman is revising the spine...',
        'applying every cut the critics agreed on...',
        'sharpening the flagged passages...',
        'protecting the kept sentences...',
        'applying voice rules before the final pass...',
    ],
    idle: ['standing by...'],
};

function pickStage({ loading }) {
    if (!loading) return 'idle';
    if (loading.stage3) return 'stage3';
    if (loading.stage2) return 'stage2';
    if (loading.stage1) return 'stage1';
    if (loading.pitch) return 'pitch';
    if (loading.search) return 'search';
    return 'idle';
}

function describeStage(stage) {
    switch (stage) {
        case 'search':
            return 'Web search';
        case 'pitch':
            return 'Pitching angles';
        case 'stage1':
            return 'Council drafting';
        case 'stage2':
            return 'Critique';
        case 'stage3':
            return 'Final revision';
        default:
            return 'Working';
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
export default function EssayLoadingStatus({ loading, progress, aborted, onAbort }) {
    const stage = pickStage({ loading });
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
        progressLabel = `${pitchProgress.count} of ${pitchProgress.total} pitches in`;
    } else if (stage === 'stage1' && stage1Progress?.total) {
        progressLabel = `${stage1Progress.count} of ${stage1Progress.total} drafts complete`;
    } else if (stage === 'stage2' && stage2Progress?.total) {
        const noun = stage2Progress.total === 1 ? 'critique' : 'critiques';
        progressLabel = `${stage2Progress.count} of ${stage2Progress.total} ${noun} in`;
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
                        title="Hide this panel to see persona progress above. The council is still running."
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
                Live status while members draft privately — final essay appears below when ready.
                A full run usually takes about a minute and a half. You can minimize this bar
                anytime.
            </div>
            <div className="essay-loading-tip">
                Want different questions or a different council? Tune your council members and voice
                rules anytime in Settings — changes apply on the next run.
            </div>
        </div>
    );
}
