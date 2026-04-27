import { useEffect, useMemo, useState } from 'react';
import './EssayLoadingStatus.css';

const MESSAGES = {
    search: [
        'consulting the wider web...',
        'pulling sources for context...',
        'reading what the internet thinks...',
    ],
    stage1: [
        'council members are drafting in parallel...',
        'the architect is sketching the spine of the essay...',
        'the editor is reaching for the scissors...',
        'the devil\'s advocate is loading objections...',
        'the voice guardian is listening for AI tells...',
        'reviewing structure and pacing...',
        'tightening prose...',
    ],
    stage2: [
        'council members are reading each other\'s drafts...',
        'ranking the strongest essays anonymously...',
        'comparing structure, argument, and voice...',
    ],
    stage3: [
        'chairman is synthesizing the final draft...',
        'applying voice rules...',
        'cutting the corporate-blog phrasing...',
        'polishing prose...',
        'making final calls on structure...',
    ],
    idle: ['standing by...'],
};

function pickStage({ loading }) {
    if (!loading) return 'idle';
    if (loading.stage3) return 'stage3';
    if (loading.stage2) return 'stage2';
    if (loading.stage1) return 'stage1';
    if (loading.search) return 'search';
    return 'idle';
}

function describeStage(stage) {
    switch (stage) {
        case 'search':
            return 'Web search';
        case 'stage1':
            return 'Council drafting';
        case 'stage2':
            return 'Peer review';
        case 'stage3':
            return 'Chairman synthesis';
        default:
            return 'Working';
    }
}

/**
 * Terminal-style "the council is working" panel shown in place of the raw
 * deliberation while an essay is being generated.
 */
export default function EssayLoadingStatus({ loading, progress, aborted }) {
    const stage = pickStage({ loading });
    const messages = useMemo(() => MESSAGES[stage] || MESSAGES.idle, [stage]);
    const [messageIdx, setMessageIdx] = useState(0);

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
    const stage1Progress = progress?.stage1;
    const stage2Progress = progress?.stage2;

    let progressLabel = null;
    if (stage === 'stage1' && stage1Progress?.total) {
        progressLabel = `${stage1Progress.count}/${stage1Progress.total} drafts in`;
    } else if (stage === 'stage2' && stage2Progress?.total) {
        progressLabel = `${stage2Progress.count}/${stage2Progress.total} reviews in`;
    }

    return (
        <div className={`essay-loading-status ${aborted ? 'aborted' : ''}`}>
            <div className="essay-loading-bar">
                <span className="essay-loading-dot" />
                <span className="essay-loading-stage">{stageLabel}</span>
                {progressLabel && (
                    <span className="essay-loading-progress">{progressLabel}</span>
                )}
            </div>
            <div className="essay-loading-line">
                <span className="essay-loading-prompt">&gt;</span>
                <span className="essay-loading-message">{messages[messageIdx]}</span>
                <span className="essay-loading-cursor" aria-hidden="true">_</span>
            </div>
            <div className="essay-loading-hint">
                The council is deliberating in private. You'll see only the final essay when it's
                ready.
            </div>
        </div>
    );
}
