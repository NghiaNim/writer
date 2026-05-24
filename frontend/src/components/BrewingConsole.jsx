import { useEffect, useMemo, useState } from 'react';
import './BrewingConsole.css';

/**
 * BrewingConsole — the in-flight drafting surface.
 *
 * Replaces the older EssayLoadingStatus terminal box. Shows:
 *
 *   1. A five-station "extraction rail" (Source → Grind → Pull → Cup → Pour)
 *      that mirrors the 3-stage council pipeline:
 *
 *        SOURCE = web search (skipped if web_search=false)
 *        GRIND  = pitch race + pitch picker
 *        PULL   = stage 1 drafts (the four espresso shots)
 *        CUP    = stage 2 critique (cupping the strongest shot)
 *        POUR   = stage 3 chairman revision
 *
 *      Each station is a CSS-drawn puck. Empty / filled / active. The
 *      active station has a slow crema-colored bloom underneath (the
 *      30s pre-infusion in pour-over). Stations to its left are filled
 *      and dimmed; stations to its right are hollow.
 *
 *   2. A live cycling status line below the rail. Same message bank as
 *      the older EssayLoadingStatus so the brewing-room copy remains
 *      consistent — but rendered in serif italic instead of monospace
 *      for warmth.
 *
 *   3. A compressed persona row: one puck per council member that
 *      lights up as that persona's stage 1 draft completes. The
 *      Chairman gets a separate gold puck that lights at stage 3.
 *
 * The Stop control is a small text link in the top-right corner —
 * intentionally NOT a red circle. The minimize control is its sibling.
 *
 * Props:
 *   loading      { search, pitch, stage1, stage2, stage3 } — current SSE flag bag
 *   progress     { pitch:{count,total}, stage1:{...}, stage2:{...} }
 *   msg          the in-flight assistant message (used for fallback stage detection
 *                between SSE phases when every loading.* is briefly false)
 *   chipState    { personas:[...], chairman, stage, stage1Done } — same shape as
 *                CouncilChips. We render a compressed row of pucks instead of chips.
 *   aborted      flag — paints the rail red and stops the animation
 *   onAbort      stop-this-stream callback. When provided, renders the Stop link.
 *   webSearched  if true, the SOURCE station starts as 'done'; if false it's
 *                rendered as 'skipped' (greyed, dotted).
 */

const STAGE_ORDER = ['search', 'pitch', 'stage1', 'stage2', 'stage3'];

const STATIONS = [
    {
        key: 'search',
        label: 'Source',
        sub: 'beans',
        // Whisper of what's actually happening at this station.
        whisper: 'sourcing the beans',
    },
    {
        key: 'pitch',
        label: 'Grind',
        sub: 'dial in',
        whisper: 'four baristas dialing in',
    },
    {
        key: 'stage1',
        label: 'Pull',
        sub: 'four shots',
        whisper: 'four shots in parallel',
    },
    {
        key: 'stage2',
        label: 'Cup',
        sub: 'taste',
        whisper: 'tasting against the rest',
    },
    {
        key: 'stage3',
        label: 'Pour',
        sub: 'finish',
        whisper: 'chairman finishes the pour',
    },
];

// Same brewing-room copy as the old EssayLoadingStatus. The voice is a quiet
// barista narrating the bar, not a system reporting events.
const MESSAGES = {
    search: [
        'sourcing beans from the wider web…',
        'checking origin notes before we grind…',
        'reading the room before we dial in…',
    ],
    pitch: [
        'four baristas dial in their grind in parallel…',
        'the architect goes coarse — a slow, structural pull…',
        "the devil's advocate goes fine — sharp, against the grain…",
        'the voice guardian opens with one concrete tasting note…',
        'cupping the pitches; picking the cleanest cup…',
    ],
    stage1: [
        'four shots pulling in parallel from the same dial-in…',
        'the architect is pulling long; load-bearing crema…',
        'the editor cuts the channel and pulls short and clean…',
        "the devil's advocate pulls against the grain on purpose…",
        'the voice guardian grounds paragraph one in a real cafe moment…',
    ],
    stage2: [
        'cupping the strongest shot against the rest…',
        'noting the over-extraction, the under-extraction, what to keep…',
        'pulling sharper notes from the runner-up shots…',
    ],
    stage3: [
        'chairman is finishing the pour…',
        'cutting the bitter notes the cuppers flagged…',
        'pulling the sweetness forward…',
        'protecting the body the cuppers asked us to keep…',
        'final pass through the voice rules before serving…',
    ],
    idle: ['cafe is open; standing by the machine…'],
};

function pickStage({ loading, msg }) {
    if (loading?.stage3) return 'stage3';
    if (loading?.stage2) return 'stage2';
    if (loading?.stage1) return 'stage1';
    if (loading?.pitch) return 'pitch';
    if (loading?.search) return 'search';
    // Between SSE phases every flag is false — fall back to the highest stage
    // we've already finished so the panel doesn't read "idle" while the
    // chairman waits for a clarification answer.
    if (msg?.stage2) return 'stage3';
    if (msg?.stage1) return 'stage2';
    if (msg?.pitches?.length) return 'stage1';
    return 'idle';
}

function stationStatus({ stationKey, currentStage, hadSearch }) {
    if (currentStage === 'idle') return 'upcoming';
    const cIdx = STAGE_ORDER.indexOf(currentStage);
    const sIdx = STAGE_ORDER.indexOf(stationKey);
    if (sIdx < 0 || cIdx < 0) return 'upcoming';
    // SOURCE is greyed (skipped) when web search wasn't run for this message.
    if (stationKey === 'search' && !hadSearch && cIdx > sIdx) return 'skipped';
    if (sIdx < cIdx) return 'done';
    if (sIdx === cIdx) return 'active';
    return 'upcoming';
}

function progressLabelFor(currentStage, progress) {
    const pitch = progress?.pitch;
    const s1 = progress?.stage1;
    const s2 = progress?.stage2;
    if (currentStage === 'pitch' && pitch?.total) {
        return `${pitch.count}/${pitch.total}`;
    }
    if (currentStage === 'stage1' && s1?.total) {
        return `${s1.count}/${s1.total}`;
    }
    if (currentStage === 'stage2' && s2?.total) {
        return `${s2.count}/${s2.total}`;
    }
    return null;
}

// One persona puck. Compressed visual of CouncilChips — name-only, no model
// label, just status. The pulse ring matches the active brewing color so the
// console reads as one rhythm instead of many.
function PersonaPuck({ name, status }) {
    return (
        <div
            className={`bc-persona bc-persona--${status}`}
            title={`${name} — ${status}`}
        >
            <span className="bc-persona-puck" aria-hidden="true" />
            <span className="bc-persona-name">{name}</span>
        </div>
    );
}

function statusForPersona(stage, idx, stage1Done) {
    if (stage === 'idle' || stage === 'search' || stage === 'pitch') {
        return 'waiting';
    }
    if (stage === 'stage1') {
        return idx < stage1Done ? 'done' : 'working';
    }
    if (stage === 'stage2') return 'reviewing';
    if (stage === 'stage3') return 'done';
    if (stage === 'done') return 'done';
    return 'waiting';
}

function statusForChairman(stage) {
    if (stage === 'stage3') return 'working';
    if (stage === 'done') return 'done';
    return 'waiting';
}

/**
 * One station on the rail. Pure visual — the parent decides status.
 *
 * Active stations render a CSS-only "drip" of three falling crema dots
 * underneath the puck to evoke pour-over. The dots stagger by 0.3s so
 * the eye reads them as flow, not as a flashing array.
 */
function Station({ station, status, progressLabel, isLast }) {
    return (
        <div className={`bc-station bc-station--${status}`}>
            <div className="bc-station-puck" aria-hidden="true">
                {status === 'active' && (
                    <span className="bc-station-drip" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                    </span>
                )}
            </div>
            <div className="bc-station-meta">
                <span className="bc-station-label">{station.label}</span>
                <span className="bc-station-sub">
                    {status === 'active' && progressLabel
                        ? progressLabel
                        : status === 'skipped'
                            ? 'skipped'
                            : station.sub}
                </span>
            </div>
            {!isLast && (
                <span
                    className={`bc-station-line bc-station-line--${status}`}
                    aria-hidden="true"
                />
            )}
        </div>
    );
}

export default function BrewingConsole({
    loading,
    progress,
    msg,
    aborted = false,
    onAbort,
    chipState = null,
    webSearched = false,
}) {
    const stage = pickStage({ loading, msg });
    const messages = useMemo(() => MESSAGES[stage] || MESSAGES.idle, [stage]);
    const [messageIdx, setMessageIdx] = useState(0);
    const [minimized, setMinimized] = useState(false);

    useEffect(() => {
        setMessageIdx(0);
    }, [stage]);

    useEffect(() => {
        if (messages.length <= 1) return undefined;
        const id = setInterval(() => {
            setMessageIdx((i) => (i + 1) % messages.length);
        }, 2400);
        return () => clearInterval(id);
    }, [messages]);

    const progressLabel = progressLabelFor(stage, progress);
    const stationProgress = progressLabel; // shown in the active station's sub-label
    const activeStation =
        STATIONS.find(
            (s) =>
                stationStatus({
                    stationKey: s.key,
                    currentStage: stage,
                    hadSearch: webSearched,
                }) === 'active'
        ) || STATIONS[0];

    if (minimized) {
        return (
            <div className={`bc-root bc-root--compact ${aborted ? 'aborted' : ''}`}>
                <button
                    type="button"
                    className="bc-compact-inner"
                    onClick={() => setMinimized(false)}
                    aria-expanded={false}
                    title="Expand brewing console"
                >
                    <span className="bc-compact-bloom" aria-hidden="true" />
                    <span className="bc-compact-stage">{activeStation.label}</span>
                    {progressLabel && (
                        <span className="bc-compact-progress">{progressLabel}</span>
                    )}
                    <span className="bc-compact-msg">{messages[messageIdx]}</span>
                    <span className="bc-compact-expand-hint" aria-hidden="true">
                        ▾
                    </span>
                </button>
            </div>
        );
    }

    return (
        <div className={`bc-root ${aborted ? 'aborted' : ''}`}>
            {/* Top edge: title, progress, controls. Stop is a quiet text link. */}
            <div className="bc-head">
                <div className="bc-head-title">
                    <span className="bc-head-bloom" aria-hidden="true" />
                    <span className="bc-head-eyebrow">Council brewing</span>
                    <span className="bc-head-stage">{activeStation.whisper}</span>
                </div>
                <div className="bc-head-actions">
                    {onAbort && !aborted && (
                        <button
                            type="button"
                            className="bc-head-stop"
                            onClick={onAbort}
                            title="Stop this run"
                        >
                            <span className="bc-head-stop-glyph" aria-hidden="true">
                                ◾
                            </span>
                            Stop
                        </button>
                    )}
                    <button
                        type="button"
                        className="bc-head-min"
                        onClick={() => setMinimized(true)}
                        title="Minimize"
                        aria-label="Minimize console"
                    >
                        ▴
                    </button>
                </div>
            </div>

            {/* Brew rail. */}
            <div
                className="bc-rail"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={STATIONS.length}
                aria-valuenow={STAGE_ORDER.indexOf(stage) + 1}
                aria-label={`Council pipeline — ${activeStation.label}`}
            >
                {STATIONS.map((s, i) => {
                    const status = stationStatus({
                        stationKey: s.key,
                        currentStage: stage,
                        hadSearch: webSearched,
                    });
                    return (
                        <Station
                            key={s.key}
                            station={s}
                            status={status}
                            progressLabel={status === 'active' ? stationProgress : null}
                            isLast={i === STATIONS.length - 1}
                        />
                    );
                })}
            </div>

            {/* Live cycling status line. Serif italic for warmth. */}
            <div className="bc-status">
                <span className="bc-status-prompt" aria-hidden="true">
                    ›
                </span>
                <span className="bc-status-msg">{messages[messageIdx]}</span>
                <span className="bc-status-cursor" aria-hidden="true">
                    
                </span>
            </div>

            {/* Compressed persona row. Muted until stage 1 starts. */}
            {chipState && chipState.personas?.length > 0 && (
                <div className="bc-personas-row" aria-label="Council personas">
                    {chipState.personas.map((p, idx) => (
                        <PersonaPuck
                            key={p.key || idx}
                            name={p.name}
                            status={statusForPersona(
                                chipState.stage,
                                idx,
                                chipState.stage1Done
                            )}
                        />
                    ))}
                    {chipState.chairman && (
                        <PersonaPuck
                            name={chipState.chairman.name || 'Chairman'}
                            status={`chairman-${statusForChairman(chipState.stage)}`}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
