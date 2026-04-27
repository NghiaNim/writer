import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import CouncilConfig from './CouncilConfig';
import './EssayFlow.css';

// Word-target presets for the Step 3 picker. Tuned for college admissions /
// statement-of-purpose use cases.
const WORD_TARGET_PRESETS = [
    { value: 250, label: '250', sub: 'short supplement' },
    { value: 500, label: '500', sub: 'standard supplement' },
    { value: 650, label: '650', sub: 'Common App' },
    { value: 1000, label: '1000', sub: 'long SoP' },
];
const DEFAULT_WORD_TARGET = 650;

/**
 * EssayFlow (Phase 3) — three-step intake before the council runs.
 *
 *   1. Topic                   single sentence, persisted as essay_sessions.topic
 *   2. The "so what" question  with a single gentle follow-up if the answer
 *                              is short or vague
 *   3. Path                    Help me write it (interactive Q&A, max 4 turns)
 *                              OR  I have a draft (paste, run council)
 *
 * On Step 3 completion, calls `onComplete({ message, essayMode, sessionId })`.
 * App-level wiring then creates a conversation and pipes `message` through
 * the existing send-message-stream so the council can run with it.
 *
 * The session row is persisted at every step transition so the user can
 * refresh and resume (resume UI itself comes in a later phase).
 */

const INTERACTIVE_PROMPTS = [
    "What's your strongest example or piece of evidence for this?",
    'Who are you writing for, and what would they push back on?',
    'What structure do you imagine — argumentative, narrative, list, something else?',
    'Anything else important — opening hook, must-include sections, length, tone?',
];

const VAGUE_PHRASES = [
    'is bad',
    'is good',
    'is important',
    'is great',
    'is terrible',
    'matters',
    'is interesting',
    'is useful',
];

function isShortOrVague(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return true;
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 15) return true;
    const lower = trimmed.toLowerCase();
    if (VAGUE_PHRASES.some((p) => lower.includes(p)) && wordCount < 25) return true;
    return false;
}

function buildDraftMessage({ topic, soWhat, draft }) {
    return [
        `TOPIC: ${topic}`,
        '',
        `NON-OBVIOUS TAKE: ${soWhat || '(not provided)'}`,
        '',
        "USER'S DRAFT:",
        (draft || '').trim(),
    ].join('\n');
}

function buildInteractiveMessage({ topic, soWhat, exchanges }) {
    const briefLines = exchanges
        .map(({ question, answer }) => `- Q: ${question}\n  A: ${(answer || '').trim()}`)
        .join('\n');
    return [
        `TOPIC: ${topic}`,
        '',
        `NON-OBVIOUS TAKE: ${soWhat || '(not provided)'}`,
        '',
        'USER BRIEF (collected from a short prep conversation):',
        briefLines || '(no notes)',
    ].join('\n');
}


// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EssayFlow({ onComplete, isBusy = false }) {
    // Step machine: 'topic' -> 'sowhat' -> 'path' -> ('interactive' | 'draft')
    const [step, setStep] = useState('topic');

    // Persisted session row (created on Step 1 submit)
    const [session, setSession] = useState(null);

    // Local form state
    const [topic, setTopic] = useState('');
    const [soWhat, setSoWhat] = useState('');
    const [showFollowup, setShowFollowup] = useState(false);
    const [draft, setDraft] = useState('');

    // Interactive Q&A state
    const [exchanges, setExchanges] = useState([]);
    const [currentAnswer, setCurrentAnswer] = useState('');

    const [memoryMatches, setMemoryMatches] = useState([]);
    const [memoryDismissed, setMemoryDismissed] = useState(false);

    // Word-target + council overrides (extension #1). Both persist to the
    // essay_sessions row before we kick off the council.
    const [wordTarget, setWordTarget] = useState(DEFAULT_WORD_TARGET);
    const [customWordTarget, setCustomWordTarget] = useState('');
    const [councilConfig, setCouncilConfig] = useState(null);
    const [councilOpen, setCouncilOpen] = useState(false);

    const [error, setError] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    // Refs for autofocus
    const topicInputRef = useRef(null);
    const soWhatRef = useRef(null);
    const draftRef = useRef(null);
    const interactiveRef = useRef(null);

    useEffect(() => {
        if (step === 'topic') topicInputRef.current?.focus();
        if (step === 'sowhat') soWhatRef.current?.focus();
        if (step === 'draft') draftRef.current?.focus();
        if (step === 'interactive') interactiveRef.current?.focus();
    }, [step]);

    // -----------------------------------------------------------------------
    // Step 1 — Topic
    // -----------------------------------------------------------------------
    const handleSubmitTopic = async (e) => {
        e?.preventDefault?.();
        setError(null);
        const trimmed = topic.trim();
        if (!trimmed) {
            setError('Please describe what your essay is about.');
            return;
        }
        setSubmitting(true);
        try {
            const created = await api.sessions.create(trimmed);
            setSession(created);
            // Memory-check is non-blocking. Failures are silent.
            api.sessions
                .memoryCheck(trimmed)
                .then((res) => {
                    if (res?.found && Array.isArray(res.matches)) {
                        setMemoryMatches(res.matches);
                    }
                })
                .catch(() => {});
            setStep('sowhat');
        } catch (e) {
            setError(e.message || 'Could not start the session.');
        } finally {
            setSubmitting(false);
        }
    };

    // -----------------------------------------------------------------------
    // Step 2 — "So what?"
    // -----------------------------------------------------------------------
    const handleSubmitSoWhat = async ({ skipFollowup = false } = {}) => {
        setError(null);
        const trimmed = soWhat.trim();
        if (!skipFollowup && !showFollowup && isShortOrVague(trimmed)) {
            // Show one gentle follow-up; user can still skip.
            setShowFollowup(true);
            return;
        }
        if (!trimmed) {
            setError("Add something for the 'so what' before continuing.");
            return;
        }
        setSubmitting(true);
        try {
            await api.sessions.update(session.id, { so_what_answer: trimmed });
            setStep('path');
        } catch (e) {
            setError(e.message || 'Could not save your answer.');
        } finally {
            setSubmitting(false);
        }
    };

    // -----------------------------------------------------------------------
    // Step 3 — Choose your path
    // -----------------------------------------------------------------------
    const handleChoosePath = async (path) => {
        setError(null);
        // Validate council config (if user opened the disclosure and customized).
        if (councilConfig) {
            const enabledCount = (councilConfig.personas || []).filter((p) => p.enabled).length;
            if (enabledCount < 2) {
                setError('Council needs at least 2 active members.');
                return;
            }
            const missing = (councilConfig.personas || []).find(
                (p) => p.enabled && !p.model
            );
            if (missing) {
                setError(`Pick a model for ${missing.key} (or disable it).`);
                return;
            }
            if (!councilConfig.chairman_model) {
                setError('Pick a Chairman model.');
                return;
            }
        }
        setSubmitting(true);
        try {
            const patch = { path };
            if (path === 'interactive') {
                patch.conversation = [];
            }
            // Persist user's word-target + council overrides on the session
            // so the streaming endpoint can resolve them via session_id.
            if (typeof wordTarget === 'number' && wordTarget > 0) {
                patch.word_target = wordTarget;
            }
            if (councilConfig) {
                patch.council_config = councilConfig;
            }
            await api.sessions.update(session.id, patch);
            setStep(path === 'draft' ? 'draft' : 'interactive');
        } catch (e) {
            setError(e.message || 'Could not save your choice.');
        } finally {
            setSubmitting(false);
        }
    };

    const handlePickPreset = (value) => {
        setWordTarget(value);
        setCustomWordTarget('');
    };

    const handleCustomWordTarget = (raw) => {
        setCustomWordTarget(raw);
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 50 && n <= 5000) {
            setWordTarget(n);
        }
    };

    const isPresetActive = (value) =>
        wordTarget === value && !customWordTarget;

    const handleSubmitDraft = async () => {
        setError(null);
        const trimmedDraft = draft.trim();
        if (!trimmedDraft) {
            setError('Paste at least a few sentences before running the council.');
            return;
        }
        setSubmitting(true);
        try {
            await api.sessions.update(session.id, {
                draft: trimmedDraft,
                status: 'ready',
            });
            const message = buildDraftMessage({
                topic: topic.trim(),
                soWhat: soWhat.trim(),
                draft: trimmedDraft,
            });
            onComplete?.({
                message,
                essayMode: 'draft',
                sessionId: session.id,
                wordTarget,
                councilConfig,
            });
        } catch (e) {
            setError(e.message || 'Could not save your draft.');
        } finally {
            setSubmitting(false);
        }
    };

    // Interactive sub-flow
    const interactiveQuestion = useMemo(() => {
        if (exchanges.length >= INTERACTIVE_PROMPTS.length) return null;
        return INTERACTIVE_PROMPTS[exchanges.length];
    }, [exchanges]);

    const persistInteractive = async (nextExchanges, finalize) => {
        const patch = {
            conversation: nextExchanges,
        };
        if (finalize) {
            patch.status = 'ready';
        }
        try {
            await api.sessions.update(session.id, patch);
        } catch (e) {
            // Non-blocking: persistence failure shouldn't trap the user
            // mid-flow. Surface but allow them to keep going.
            setError('Could not save your last answer (will try again).');
            // eslint-disable-next-line no-console
            console.warn('persistInteractive failed:', e);
        }
    };

    const handleAnswerInteractive = async () => {
        const answer = currentAnswer.trim();
        if (!answer) {
            setError('Add a quick answer (or click "Ready to write" to finish early).');
            return;
        }
        setError(null);
        const next = [...exchanges, { question: interactiveQuestion, answer }];
        setExchanges(next);
        setCurrentAnswer('');
        if (next.length >= INTERACTIVE_PROMPTS.length) {
            await persistInteractive(next, true);
            finishInteractive(next);
        } else {
            persistInteractive(next, false);
        }
    };

    const finishInteractive = (finalExchanges) => {
        const message = buildInteractiveMessage({
            topic: topic.trim(),
            soWhat: soWhat.trim(),
            exchanges: finalExchanges,
        });
        onComplete?.({
            message,
            essayMode: 'topic',
            sessionId: session.id,
            wordTarget,
            councilConfig,
        });
    };

    const handleReadyToWrite = async () => {
        setError(null);
        setSubmitting(true);
        try {
            await persistInteractive(exchanges, true);
            finishInteractive(exchanges);
        } finally {
            setSubmitting(false);
        }
    };

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------
    const disabled = submitting || isBusy;

    return (
        <div className="essay-flow">
            <div className="essay-flow-card">
                {/* topic chip on every step after the first */}
                {step !== 'topic' && (
                    <div className="essay-flow-topic-chip" title={topic}>
                        Topic: <span>{topic}</span>
                    </div>
                )}

                {step === 'topic' && (
                    <form onSubmit={handleSubmitTopic} className="essay-flow-step">
                        <h1 className="essay-flow-question">What is your essay about?</h1>
                        <p className="essay-flow-hint">One sentence is enough.</p>
                        <input
                            ref={topicInputRef}
                            type="text"
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            placeholder="e.g. Why remote work makes cities worse over time"
                            disabled={disabled}
                            className="essay-flow-input"
                            maxLength={500}
                        />
                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-actions">
                            <button
                                type="submit"
                                className="essay-flow-primary"
                                disabled={disabled || !topic.trim()}
                            >
                                {submitting ? 'Starting…' : 'Continue'}
                            </button>
                        </div>
                    </form>
                )}

                {step === 'sowhat' && (
                    <div className="essay-flow-step">
                        {!showFollowup ? (
                            <>
                                <h2 className="essay-flow-question">
                                    What's the non-obvious thing you want to say about this?
                                </h2>
                                <p className="essay-flow-hint">
                                    What would someone who already agrees with you still learn?
                                </p>
                            </>
                        ) : (
                            <>
                                <h2 className="essay-flow-question">
                                    Can you be more specific?
                                </h2>
                                <p className="essay-flow-hint">
                                    What's your actual take — something most people wouldn't
                                    immediately say?
                                </p>
                            </>
                        )}
                        <textarea
                            ref={soWhatRef}
                            value={soWhat}
                            onChange={(e) => setSoWhat(e.target.value)}
                            placeholder="Write 1–3 sentences."
                            rows={5}
                            disabled={disabled}
                            className="essay-flow-textarea"
                        />
                        {memoryMatches.length > 0 && !memoryDismissed && (
                            <div className="essay-flow-memory" role="status">
                                <span>
                                    You've written about this before — {memoryMatches.length}{' '}
                                    {memoryMatches.length === 1 ? 'past essay' : 'past essays'} look
                                    related. Want to keep it fresh?
                                </span>
                                <button
                                    type="button"
                                    className="essay-flow-memory-dismiss"
                                    onClick={() => setMemoryDismissed(true)}
                                    aria-label="Dismiss"
                                >
                                    ×
                                </button>
                            </div>
                        )}
                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-actions">
                            {showFollowup && (
                                <button
                                    type="button"
                                    className="essay-flow-link"
                                    onClick={() => handleSubmitSoWhat({ skipFollowup: true })}
                                    disabled={disabled || !soWhat.trim()}
                                >
                                    Skip, use this
                                </button>
                            )}
                            <button
                                type="button"
                                className="essay-flow-primary"
                                disabled={disabled || !soWhat.trim()}
                                onClick={() => handleSubmitSoWhat()}
                            >
                                {submitting ? 'Saving…' : 'This looks good → continue'}
                            </button>
                        </div>
                    </div>
                )}

                {step === 'path' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">How do you want to start?</h2>

                        {/* Word-target picker (extension #1) */}
                        <div className="essay-flow-section">
                            <div className="essay-flow-section-label">Target length</div>
                            <div className="essay-flow-word-targets">
                                {WORD_TARGET_PRESETS.map((p) => (
                                    <button
                                        key={p.value}
                                        type="button"
                                        className={`essay-flow-chip ${
                                            isPresetActive(p.value) ? 'active' : ''
                                        }`}
                                        onClick={() => handlePickPreset(p.value)}
                                        disabled={disabled}
                                    >
                                        <span className="chip-main">{p.label}</span>
                                        <span className="chip-sub">{p.sub}</span>
                                    </button>
                                ))}
                                <div
                                    className={`essay-flow-chip custom ${
                                        customWordTarget ? 'active' : ''
                                    }`}
                                >
                                    <input
                                        type="number"
                                        min={50}
                                        max={5000}
                                        step={50}
                                        placeholder="custom"
                                        value={customWordTarget}
                                        onChange={(e) => handleCustomWordTarget(e.target.value)}
                                        disabled={disabled}
                                        className="essay-flow-chip-input"
                                    />
                                    <span className="chip-sub">words</span>
                                </div>
                            </div>
                            <div className="essay-flow-word-target-summary">
                                Final essay aims for ~{wordTarget} words.
                            </div>
                        </div>

                        {/* Council disclosure (extension #1) */}
                        <div className="essay-flow-section">
                            <button
                                type="button"
                                className="essay-flow-disclosure"
                                onClick={() => setCouncilOpen((v) => !v)}
                                disabled={disabled}
                                aria-expanded={councilOpen}
                            >
                                <span className="essay-flow-disclosure-arrow">
                                    {councilOpen ? '▾' : '▸'}
                                </span>
                                <span>
                                    {councilOpen
                                        ? 'Hide council settings'
                                        : 'Customize council for this essay'}
                                </span>
                                <span className="essay-flow-disclosure-hint">
                                    {councilOpen ? '' : '(uses your default if untouched)'}
                                </span>
                            </button>
                            {councilOpen && (
                                <div className="essay-flow-council-wrapper">
                                    <CouncilConfig
                                        value={councilConfig}
                                        onChange={(next) => setCouncilConfig(next)}
                                        showSave={false}
                                        compact
                                    />
                                </div>
                            )}
                        </div>

                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-paths">
                            <button
                                type="button"
                                className="essay-flow-path-card"
                                disabled={disabled}
                                onClick={() => handleChoosePath('interactive')}
                            >
                                <div className="essay-flow-path-title">Help me write it</div>
                                <div className="essay-flow-path-desc">
                                    Chat through your ideas first. We'll ask a few questions, then write.
                                </div>
                            </button>
                            <button
                                type="button"
                                className="essay-flow-path-card"
                                disabled={disabled}
                                onClick={() => handleChoosePath('draft')}
                            >
                                <div className="essay-flow-path-title">I have a draft</div>
                                <div className="essay-flow-path-desc">
                                    Paste what you have — even rough notes or bullet points.
                                </div>
                            </button>
                        </div>
                    </div>
                )}

                {step === 'draft' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">Paste your draft</h2>
                        <p className="essay-flow-hint">
                            Rough is fine — bullet points, half-sentences, anything you have.
                        </p>
                        <textarea
                            ref={draftRef}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder="Paste your draft here…"
                            rows={14}
                            disabled={disabled}
                            className="essay-flow-textarea essay-flow-textarea-large"
                        />
                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-link"
                                onClick={() => setStep('path')}
                                disabled={disabled}
                            >
                                ← Back
                            </button>
                            <button
                                type="button"
                                className="essay-flow-primary"
                                disabled={disabled || !draft.trim()}
                                onClick={handleSubmitDraft}
                            >
                                {submitting ? 'Saving…' : 'Run the council'}
                            </button>
                        </div>
                    </div>
                )}

                {step === 'interactive' && (
                    <div className="essay-flow-step">
                        <div className="essay-flow-progress">
                            Question {Math.min(exchanges.length + 1, INTERACTIVE_PROMPTS.length)} of{' '}
                            {INTERACTIVE_PROMPTS.length}
                        </div>

                        {exchanges.length > 0 && (
                            <div className="essay-flow-history">
                                {exchanges.map((ex, i) => (
                                    <div key={i} className="essay-flow-exchange">
                                        <div className="essay-flow-exchange-q">{ex.question}</div>
                                        <div className="essay-flow-exchange-a">{ex.answer}</div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {interactiveQuestion ? (
                            <>
                                <h2 className="essay-flow-question essay-flow-question-small">
                                    {interactiveQuestion}
                                </h2>
                                <textarea
                                    ref={interactiveRef}
                                    value={currentAnswer}
                                    onChange={(e) => setCurrentAnswer(e.target.value)}
                                    placeholder="Type your answer…"
                                    rows={4}
                                    disabled={disabled}
                                    className="essay-flow-textarea"
                                />
                                {error && <div className="essay-flow-error">{error}</div>}
                                <div className="essay-flow-actions">
                                    <button
                                        type="button"
                                        className="essay-flow-link"
                                        onClick={handleReadyToWrite}
                                        disabled={disabled || exchanges.length === 0}
                                        title={
                                            exchanges.length === 0
                                                ? 'Answer at least one question first'
                                                : 'Stop here and run the council'
                                        }
                                    >
                                        Ready to write →
                                    </button>
                                    <button
                                        type="button"
                                        className="essay-flow-primary"
                                        disabled={disabled || !currentAnswer.trim()}
                                        onClick={handleAnswerInteractive}
                                    >
                                        {submitting ? 'Saving…' : 'Next'}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div className="essay-flow-actions">
                                <button
                                    type="button"
                                    className="essay-flow-primary"
                                    onClick={handleReadyToWrite}
                                    disabled={disabled}
                                >
                                    {submitting ? 'Saving…' : 'Run the council'}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
