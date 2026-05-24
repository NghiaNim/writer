import { useEffect, useMemo, useState } from 'react';
import './BrewBar.css';

/**
 * BrewBar — slim bottom strip shown during a council run.
 *
 * Replaces two old composer states:
 *
 *   1. The collapsed-refinement strip with the fat white "Expand refinement"
 *      button, the duplicated "Council is updating your essay" hint, and the
 *      orange/red ⏹ orb.
 *   2. The "composer-status-pill" rendered when there's no refinement dock
 *      yet (first essay in a fresh conversation).
 *
 * What's wrong with the old strip (per the user):
 *   - The Stop control is the visual loudest thing on the screen, but the
 *     user almost never wants to abort. Wrong emphasis.
 *   - "Expand refinement" is a fat full-width button — implies it's the
 *     primary action when in fact nothing is actionable until the run ends.
 *   - "Council is updating your essay" duplicates the rail above.
 *
 * What this bar does instead:
 *   - One thin horizontal rail at the top showing what % of the brewing
 *     pipeline is done. Calm, ambient, no flashing.
 *   - Stage label + live cycling whisper in the middle (single source of
 *     truth — the same message the BrewingConsole shows).
 *   - "Refine ▴" is a small text pull-tab on the right (only when a
 *     refinement dock exists to pull up) — secondary affordance, not a CTA.
 *   - Stop is a quiet text link, not a colored button.
 *
 * Props:
 *   stage          'search' | 'pitch' | 'stage1' | 'stage2' | 'stage3' | 'idle'
 *   stageLabel     short label ('Source', 'Grind', 'Pull', 'Cup', 'Pour')
 *   stageWhisper   one-line live message (cycles)
 *   progress       null | { count, total } — for the active stage
 *   percentDone    0..1 — overall pipeline progress (drives the rail)
 *   aborted        boolean
 *   onAbort        stop callback
 *   onExpand       optional callback to open the refinement dock; when null,
 *                  the "Refine ▴" pull-tab is hidden
 */

// Same brewing-room copy as BrewingConsole — kept duplicated rather than
// imported so the bar can render independently in callers that don't mount
// the console (e.g., very small viewports or future surfaces).
const MESSAGES = {
    search: [
        'sourcing beans from the wider web…',
        'checking origin notes before we grind…',
    ],
    pitch: [
        'four baristas dial in their grind…',
        'cupping the pitches; picking the cleanest cup…',
    ],
    stage1: [
        'four shots pulling in parallel…',
        'the architect is pulling long; load-bearing crema…',
        "the devil's advocate pulls against the grain on purpose…",
    ],
    stage2: [
        'cupping the strongest shot against the rest…',
        'noting what to cut, sharpen, and keep…',
    ],
    stage3: [
        'chairman is finishing the pour…',
        'cutting the bitter notes the cuppers flagged…',
        'final pass through the voice rules before serving…',
    ],
    idle: ['standing by the machine…'],
};

const STAGE_LABELS = {
    search: 'Source',
    pitch: 'Grind',
    stage1: 'Pull',
    stage2: 'Cup',
    stage3: 'Pour',
    idle: 'At the bar',
};

const STAGE_WEIGHT = {
    idle: 0,
    search: 0.05,
    pitch: 0.2,
    stage1: 0.55,
    stage2: 0.75,
    stage3: 0.95,
};

function pickStage(loading, msg) {
    if (loading?.stage3) return 'stage3';
    if (loading?.stage2) return 'stage2';
    if (loading?.stage1) return 'stage1';
    if (loading?.pitch) return 'pitch';
    if (loading?.search) return 'search';
    if (msg?.stage2) return 'stage3';
    if (msg?.stage1) return 'stage2';
    if (msg?.pitches?.length) return 'stage1';
    return 'idle';
}

function pickProgress(stage, progress) {
    if (stage === 'pitch' && progress?.pitch?.total) return progress.pitch;
    if (stage === 'stage1' && progress?.stage1?.total) return progress.stage1;
    if (stage === 'stage2' && progress?.stage2?.total) return progress.stage2;
    return null;
}

function pickPercent(stage, stageProgress) {
    const base = STAGE_WEIGHT[stage] ?? 0;
    if (!stageProgress?.total) return base;
    const next =
        stage === 'search'
            ? STAGE_WEIGHT.pitch
            : stage === 'pitch'
                ? STAGE_WEIGHT.stage1
                : stage === 'stage1'
                    ? STAGE_WEIGHT.stage2
                    : stage === 'stage2'
                        ? STAGE_WEIGHT.stage3
                        : 1;
    const within = Math.max(0, Math.min(1, stageProgress.count / stageProgress.total));
    return base + (next - base) * within;
}

export default function BrewBar({
    loading,
    progress,
    msg,
    aborted = false,
    onAbort,
    onExpand,
}) {
    const stage = pickStage(loading, msg);
    const stageLabel = STAGE_LABELS[stage] || 'At the bar';
    const stageProgress = pickProgress(stage, progress);
    const percent = pickPercent(stage, stageProgress);

    const messages = useMemo(() => MESSAGES[stage] || MESSAGES.idle, [stage]);
    const [messageIdx, setMessageIdx] = useState(0);

    useEffect(() => {
        setMessageIdx(0);
    }, [stage]);

    useEffect(() => {
        if (messages.length <= 1) return undefined;
        const id = setInterval(() => {
            setMessageIdx((i) => (i + 1) % messages.length);
        }, 2800);
        return () => clearInterval(id);
    }, [messages]);

    const railPct = Math.max(0.04, Math.min(1, percent));

    return (
        <div
            className={`brewbar${aborted ? ' brewbar--aborted' : ''}`}
            role="status"
            aria-live="polite"
        >
            <div
                className="brewbar__rail"
                aria-label="Council pipeline progress"
                aria-valuenow={Math.round(railPct * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                role="progressbar"
            >
                <div
                    className="brewbar__rail-fill"
                    style={{ width: `${railPct * 100}%` }}
                />
                <div className="brewbar__rail-shimmer" aria-hidden="true" />
            </div>

            <div className="brewbar__row">
                <div className="brewbar__stage" aria-hidden="true">
                    <span className="brewbar__bloom" />
                    <span className="brewbar__stage-label">{stageLabel}</span>
                    {stageProgress && (
                        <span className="brewbar__stage-count">
                            {stageProgress.count}/{stageProgress.total}
                        </span>
                    )}
                </div>

                <div className="brewbar__msg">{messages[messageIdx]}</div>

                <div className="brewbar__actions">
                    {onExpand && (
                        <button
                            type="button"
                            className="brewbar__refine"
                            onClick={onExpand}
                            title="Open refinement panel"
                        >
                            Refine
                            <span className="brewbar__refine-glyph" aria-hidden="true">
                                ▴
                            </span>
                        </button>
                    )}
                    {onAbort && !aborted && (
                        <button
                            type="button"
                            className="brewbar__stop"
                            onClick={onAbort}
                            title="Stop this run"
                        >
                            <span className="brewbar__stop-glyph" aria-hidden="true">
                                ◾
                            </span>
                            Stop
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
