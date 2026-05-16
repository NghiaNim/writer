import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import CouncilConfig from './CouncilConfig';
import MicButton from './common/MicButton';
import './EssayFlow.css';

// Word-target presets for the Step 4 picker. Tuned for college admissions /
// statement-of-purpose use cases.
const WORD_TARGET_PRESETS = [
    { value: 250, label: '250', sub: 'short supplement' },
    { value: 500, label: '500', sub: 'standard supplement' },
    { value: 650, label: '650', sub: 'Common App' },
    { value: 1000, label: '1000', sub: 'long SoP' },
];
const DEFAULT_WORD_TARGET = 650;

/**
 * EssayFlow — smart 4-step intake.
 *
 *   Step 1  topic        topic + audience ("I want to write about ___ for ___")
 *   Step 2  questions    LLM-generated 3-5 probing questions, answered inline
 *   Step 3  core idea    LLM-drafted 1-paragraph brief, user can refine
 *   Step 4  voice        authors-you-admire + word target + council disclosure
 *
 * On Step 4 completion, calls `onComplete({ message, essayMode, sessionId,
 * wordTarget, councilConfig })`. App.jsx then creates a conversation and pipes
 * `message` through the existing send-message-stream so the council can run.
 *
 * Draft path: a small "I already have a draft" link on Step 1 jumps to a
 * compact draft step that bypasses Steps 2 + 3 (we don't want to force a
 * Q&A loop on someone who already wrote something).
 *
 * The session row is persisted at every transition so the user can refresh
 * and resume.
 */

function buildDraftMessage({ topic, audience, draft }) {
    return [
        `TOPIC: ${topic}`,
        audience ? `AUDIENCE: ${audience}` : '',
        '',
        "USER'S DRAFT:",
        (draft || '').trim(),
    ]
        .filter(Boolean)
        .join('\n');
}

function buildInteractiveMessage({ topic, audience, qa, coreIdea, authors }) {
    const briefLines = qa
        .map(({ question, answer }) => `- Q: ${question}\n  A: ${(answer || '').trim()}`)
        .join('\n');
    return [
        `TOPIC: ${topic}`,
        audience ? `AUDIENCE: ${audience}` : '',
        '',
        coreIdea ? 'CORE IDEA:' : '',
        coreIdea || '',
        '',
        'USER BRIEF (collected from a short prep conversation):',
        briefLines || '(no notes)',
        authors && authors.length
            ? `\nAUTHORS THE USER ADMIRES (lean toward this stylistic register without naming them in the essay): ${authors.join(', ')}`
            : '',
    ]
        .filter(Boolean)
        .join('\n');
}


function formatRelativeDate(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    const diffMs = Date.now() - then.getTime();
    const day = 86400000;
    const days = Math.floor(diffMs / day);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) {
        const w = Math.floor(days / 7);
        return w === 1 ? '1 week ago' : `${w} weeks ago`;
    }
    if (days < 365) {
        const m = Math.floor(days / 30);
        return m === 1 ? '1 month ago' : `${m} months ago`;
    }
    const y = Math.floor(days / 365);
    return y === 1 ? '1 year ago' : `${y} years ago`;
}


// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EssayFlow({
    onComplete,
    isBusy = false,
    handoffError = null,
    onDismissHandoffError,
    onOpenVoiceSettings,
    onOpenPastEssay,
}) {
    // Steps: 'topic' -> 'questions' -> 'core_idea' -> 'voice' (-> submit)
    //                  | 'draft' (alternate path from Step 1)
    const [step, setStep] = useState('topic');

    // Persisted session row (created on Step 1 submit)
    const [session, setSession] = useState(null);

    // Step 1 state
    const [topic, setTopic] = useState('');
    const [audience, setAudience] = useState('');

    // Step 2 state
    const [questions, setQuestions] = useState([]);
    const [questionsLoading, setQuestionsLoading] = useState(false);
    const [answers, setAnswers] = useState({}); // { [questionIdx]: 'answer text' }
    // Questions the user has intentionally chosen to skip. Continue is
    // gated on every question being either answered OR explicitly
    // skipped, so users move forward without being forced to answer
    // each one.
    const [skippedQuestions, setSkippedQuestions] = useState(new Set());

    // Step 3 state
    const [coreIdea, setCoreIdea] = useState('');
    const [coreIdeaLoading, setCoreIdeaLoading] = useState(false);

    // Step 4 state
    const [authorsText, setAuthorsText] = useState('');
    const [wordTarget, setWordTarget] = useState(DEFAULT_WORD_TARGET);
    const [customWordTarget, setCustomWordTarget] = useState('');
    const [councilConfig, setCouncilConfig] = useState(null);
    const [councilOpen, setCouncilOpen] = useState(false);

    // Draft alternate path
    const [draft, setDraft] = useState('');

    // Memory-check banner (silent past-essay lookup)
    const [memoryMatches, setMemoryMatches] = useState([]);
    const [memoryDismissed, setMemoryDismissed] = useState(false);
    const [memoryExpanded, setMemoryExpanded] = useState(false);

    // Per-question example state: { [i]: { loading, error, text } }
    const [examples, setExamples] = useState({});

    const handleShowExample = async (i, question) => {
        const current = examples[i];
        // Toggle off if already loaded.
        if (current && current.text) {
            setExamples((prev) => ({ ...prev, [i]: { ...prev[i], hidden: !prev[i].hidden } }));
            return;
        }
        setExamples((prev) => ({ ...prev, [i]: { loading: true, error: null, text: '' } }));
        try {
            const res = await api.intake.example({
                topic: topic.trim(),
                audience: audience.trim(),
                question,
            });
            setExamples((prev) => ({
                ...prev,
                [i]: {
                    loading: false,
                    error: null,
                    text: (res?.example || '').trim(),
                    hidden: false,
                },
            }));
        } catch (err) {
            setExamples((prev) => ({
                ...prev,
                [i]: {
                    loading: false,
                    error: err?.message || 'Could not load example',
                    text: '',
                },
            }));
        }
    };

    const handleRegenerateExample = async (i, question) => {
        setExamples((prev) => ({ ...prev, [i]: { loading: true, error: null, text: '' } }));
        try {
            const res = await api.intake.example({
                topic: topic.trim(),
                audience: audience.trim(),
                question,
            });
            setExamples((prev) => ({
                ...prev,
                [i]: {
                    loading: false,
                    error: null,
                    text: (res?.example || '').trim(),
                    hidden: false,
                },
            }));
        } catch (err) {
            setExamples((prev) => ({
                ...prev,
                [i]: {
                    loading: false,
                    error: err?.message || 'Could not load example',
                    text: '',
                },
            }));
        }
    };

    const [error, setError] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    // Refs for autofocus
    const topicRef = useRef(null);
    const draftRef = useRef(null);
    const coreIdeaRef = useRef(null);

    useEffect(() => {
        if (step === 'topic') topicRef.current?.focus();
        if (step === 'draft') draftRef.current?.focus();
        if (step === 'core_idea') coreIdeaRef.current?.focus();
    }, [step]);

    // -----------------------------------------------------------------------
    // Step 1 — Topic + Audience
    // -----------------------------------------------------------------------
    const handleSubmitTopic = async (e) => {
        e?.preventDefault?.();
        setError(null);
        const trimmedTopic = topic.trim();
        if (!trimmedTopic) {
            setError('Tell me what your essay is about.');
            return;
        }
        setSubmitting(true);
        try {
            const created = await api.sessions.create(trimmedTopic);
            setSession(created);
            // Memory-check is non-blocking. Failures are silent.
            api.sessions
                .memoryCheck(trimmedTopic)
                .then((res) => {
                    if (res?.found && Array.isArray(res.matches)) {
                        setMemoryMatches(res.matches);
                    }
                })
                .catch(() => {});

            // Kick off questions LLM call as we transition.
            setStep('questions');
            setQuestionsLoading(true);
            try {
                const res = await api.intake.questions({
                    topic: trimmedTopic,
                    audience: audience.trim(),
                });
                setQuestions(Array.isArray(res?.questions) ? res.questions : []);
            } catch (err) {
                console.warn('intake/questions failed:', err);
                setQuestions([
                    "What's the strongest specific moment, scene, or example you'd build this around?",
                    "What's the non-obvious thing you want this audience to understand?",
                    "What contradiction or tension lives inside this topic for you?",
                ]);
            } finally {
                setQuestionsLoading(false);
            }
        } catch (err) {
            setError(err.message || 'Could not start the session.');
        } finally {
            setSubmitting(false);
        }
    };

    const handleJumpToDraft = async () => {
        setError(null);
        const trimmedTopic = topic.trim();
        if (!trimmedTopic) {
            setError('Tell me what your essay is about first.');
            return;
        }
        setSubmitting(true);
        try {
            let s = session;
            if (!s) {
                s = await api.sessions.create(trimmedTopic);
                setSession(s);
            }
            await api.sessions.update(s.id, {
                path: 'draft',
                ...(audience.trim() ? { /* audience persisted on intake/core-idea below */ } : {}),
            });
            setStep('draft');
        } catch (err) {
            setError(err.message || 'Could not switch to draft mode.');
        } finally {
            setSubmitting(false);
        }
    };

    // -----------------------------------------------------------------------
    // Step 2 — Answer the LLM-generated questions
    // -----------------------------------------------------------------------
    // "Ready to continue" = every question is either answered OR
    // explicitly skipped via its per-question Skip button. This lets users
    // bypass individual questions they have nothing for without having to
    // figure out an unrelated "Skip the rest" link.
    const allQuestionsHandled = useMemo(() => {
        if (!questions.length) return false;
        return questions.every(
            (_, i) => (answers[i] || '').trim().length > 0 || skippedQuestions.has(i)
        );
    }, [questions, answers, skippedQuestions]);

    const handleAnswerChange = (idx, value) => {
        setAnswers((prev) => ({ ...prev, [idx]: value }));
        // Typing into a previously-skipped question un-skips it
        // automatically — the user clearly has something to say.
        if (skippedQuestions.has(idx) && value.trim().length > 0) {
            setSkippedQuestions((prev) => {
                const next = new Set(prev);
                next.delete(idx);
                return next;
            });
        }
    };

    const handleSkipQuestion = (idx) => {
        setSkippedQuestions((prev) => {
            const next = new Set(prev);
            next.add(idx);
            return next;
        });
        // Clear any partial text so the saved Q&A doesn't accidentally
        // include "ugh I don't know" or a half-thought.
        setAnswers((prev) => {
            if (!prev[idx]) return prev;
            const next = { ...prev };
            delete next[idx];
            return next;
        });
    };

    const handleUnskipQuestion = (idx) => {
        setSkippedQuestions((prev) => {
            if (!prev.has(idx)) return prev;
            const next = new Set(prev);
            next.delete(idx);
            return next;
        });
    };

    const handleSubmitAnswers = async () => {
        setError(null);
        const answeredCount = questions.filter((_, i) => (answers[i] || '').trim()).length;
        if (answeredCount < 1) {
            setError("Answer at least one question — even one short reply gives the council something concrete to work with.");
            return;
        }
        await advanceToCoreIdea();
    };

    const advanceToCoreIdea = async () => {
        setSubmitting(true);
        try {
            const qa = questions
                .map((q, i) => ({ question: q, answer: (answers[i] || '').trim() }))
                .filter((item) => item.answer);
            await api.sessions.update(session.id, {
                conversation: qa,
            });
            setStep('core_idea');
            setCoreIdeaLoading(true);
            try {
                const res = await api.intake.coreIdea({
                    topic: topic.trim(),
                    audience: audience.trim(),
                    qa,
                    sessionId: session.id,
                });
                setCoreIdea(res?.core_idea || '');
            } catch (err) {
                console.warn('intake/core-idea failed:', err);
                setCoreIdea('');
            } finally {
                setCoreIdeaLoading(false);
            }
        } catch (err) {
            setError(err.message || 'Could not save your answers.');
        } finally {
            setSubmitting(false);
        }
    };

    // -----------------------------------------------------------------------
    // Step 3 — Approve / refine the core idea brief
    // -----------------------------------------------------------------------
    const handleApproveCoreIdea = async () => {
        setError(null);
        const trimmed = (coreIdea || '').trim();
        if (!trimmed) {
            setError('Add at least a sentence to your core idea before continuing.');
            return;
        }
        setSubmitting(true);
        try {
            await api.sessions.update(session.id, { core_idea: trimmed });
            setStep('voice');
        } catch (err) {
            setError(err.message || 'Could not save the core idea.');
        } finally {
            setSubmitting(false);
        }
    };

    // -----------------------------------------------------------------------
    // Step 4 — Voice setup + word target + council overrides
    // -----------------------------------------------------------------------
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

    const parseAuthors = (raw) =>
        (raw || '')
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 5);

    const handleStartCouncil = async () => {
        setError(null);
        // Validate council config (if user opened the disclosure).
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

        const authors = parseAuthors(authorsText);
        setSubmitting(true);
        try {
            const patch = { path: 'interactive', status: 'ready' };
            if (typeof wordTarget === 'number' && wordTarget > 0) {
                patch.word_target = wordTarget;
            }
            if (councilConfig) {
                patch.council_config = councilConfig;
            }
            await api.sessions.update(session.id, patch);

            // Save preferred authors onto the user's voice profile so future
            // essays inherit them. Best-effort — failure shouldn't block run.
            if (authors.length) {
                try {
                    await api.voice.save({ preferred_authors: authors });
                } catch (err) {
                    console.warn('voice.save preferred_authors failed:', err);
                }
            }

            const qa = questions
                .map((q, i) => ({ question: q, answer: (answers[i] || '').trim() }))
                .filter((item) => item.answer);
            const message = buildInteractiveMessage({
                topic: topic.trim(),
                audience: audience.trim(),
                qa,
                coreIdea: coreIdea.trim(),
                authors,
            });
            onComplete?.({
                message,
                essayMode: 'topic',
                sessionId: session.id,
                wordTarget,
                councilConfig,
            });
        } catch (err) {
            setError(err.message || 'Could not start the council.');
        } finally {
            setSubmitting(false);
        }
    };

    // -----------------------------------------------------------------------
    // Draft alternate path
    // -----------------------------------------------------------------------
    const handleSubmitDraft = async () => {
        setError(null);
        const trimmedDraft = draft.trim();
        if (!trimmedDraft) {
            setError('Paste at least a few sentences before running the council.');
            return;
        }
        // Default word target + no council override on the draft path.
        setSubmitting(true);
        try {
            await api.sessions.update(session.id, {
                draft: trimmedDraft,
                status: 'ready',
                word_target: wordTarget,
            });
            const message = buildDraftMessage({
                topic: topic.trim(),
                audience: audience.trim(),
                draft: trimmedDraft,
            });
            onComplete?.({
                message,
                essayMode: 'draft',
                sessionId: session.id,
                wordTarget,
                councilConfig: null,
            });
        } catch (err) {
            setError(err.message || 'Could not save your draft.');
        } finally {
            setSubmitting(false);
        }
    };

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------
    const disabled = submitting || isBusy;
    const showTopicChip = step !== 'topic';

    // Visible step indicator — only for the main 4-step intake. The draft
    // branch (topic → draft) is a 2-step express path and the chip in the
    // header is enough orientation there.
    const STEP_ORDER = ['topic', 'questions', 'core_idea', 'voice'];
    const STEP_LABELS = {
        topic: 'Topic & audience',
        questions: 'A few questions',
        core_idea: 'Your core idea',
        voice: 'Voice & ready',
    };
    const stepIndex = STEP_ORDER.indexOf(step);
    const showStepper = stepIndex >= 0;

    return (
        <div className="essay-flow">
            <div className="essay-flow-card">
                {handoffError && (
                    <div className="essay-flow-handoff-error" role="alert">
                        <span>{handoffError}</span>
                        {onDismissHandoffError ? (
                            <button
                                type="button"
                                className="essay-flow-memory-dismiss"
                                onClick={onDismissHandoffError}
                                aria-label="Dismiss"
                            >
                                ×
                            </button>
                        ) : null}
                    </div>
                )}
                {showTopicChip && (
                    <div className="essay-flow-topic-chip" title={topic}>
                        Topic: <span>{topic}</span>
                        {audience && (
                            <>
                                <span style={{ opacity: 0.5, margin: '0 4px' }}>·</span>
                                <span>for {audience}</span>
                            </>
                        )}
                    </div>
                )}

                {showStepper && (
                    <div className="essay-flow-stepper" aria-label="Intake progress">
                        <div className="essay-flow-stepper-label">
                            Step {stepIndex + 1} of {STEP_ORDER.length} · {STEP_LABELS[step]}
                        </div>
                        <div className="essay-flow-stepper-dots">
                            {STEP_ORDER.map((s, i) => (
                                <span
                                    key={s}
                                    className={
                                        'essay-flow-stepper-dot ' +
                                        (i < stepIndex
                                            ? 'essay-flow-stepper-dot--done'
                                            : i === stepIndex
                                                ? 'essay-flow-stepper-dot--active'
                                                : 'essay-flow-stepper-dot--pending')
                                    }
                                    aria-label={`Step ${i + 1}`}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {step === 'topic' && (
                    <form onSubmit={handleSubmitTopic} className="essay-flow-step">
                        <h1 className="essay-flow-question">What is your essay about?</h1>

                        <div className="essay-flow-field">
                            <label htmlFor="essay-flow-topic" className="essay-flow-label">
                                Topic
                            </label>
                            <p className="essay-flow-field-hint">
                                One sentence — the smallest true thing about your essay.
                            </p>
                            <input
                                id="essay-flow-topic"
                                ref={topicRef}
                                type="text"
                                value={topic}
                                onChange={(e) => setTopic(e.target.value)}
                                placeholder="e.g. The summer I learned my mother had been a smuggler"
                                disabled={disabled}
                                className="essay-flow-input"
                                maxLength={500}
                            />
                        </div>

                        <div className="essay-flow-field">
                            <label htmlFor="essay-flow-audience" className="essay-flow-label">
                                Audience
                            </label>
                            <p className="essay-flow-field-hint">
                                Who's reading this? Be specific — the answer changes everything.
                            </p>
                            <input
                                id="essay-flow-audience"
                                type="text"
                                value={audience}
                                onChange={(e) => setAudience(e.target.value)}
                                placeholder="e.g. an MIT admissions officer, a creative writing professor"
                                disabled={disabled}
                                className="essay-flow-input"
                                maxLength={250}
                            />
                        </div>

                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-link"
                                onClick={handleJumpToDraft}
                                disabled={disabled || !topic.trim()}
                            >
                                I already have a draft →
                            </button>
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

                {step === 'questions' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">A few quick questions</h2>
                        <p className="essay-flow-hint">
                            These help the council write something that actually sounds like you.
                            Skim them — answers can be short.
                        </p>
                        {questionsLoading && (
                            <div className="essay-flow-hint" style={{ opacity: 0.8 }}>
                                Drafting questions for your topic…
                            </div>
                        )}
                        {memoryMatches.length > 0 && !memoryDismissed && (
                            <div className="essay-flow-memory" role="status">
                                <button
                                    type="button"
                                    className="essay-flow-memory-header"
                                    onClick={() => setMemoryExpanded((v) => !v)}
                                    aria-expanded={memoryExpanded}
                                >
                                    <span className="essay-flow-memory-chevron" aria-hidden="true">
                                        {memoryExpanded ? '▾' : '▸'}
                                    </span>
                                    <span className="essay-flow-memory-text">
                                        You've written about this before — {memoryMatches.length}{' '}
                                        {memoryMatches.length === 1 ? 'past essay' : 'past essays'}{' '}
                                        {memoryMatches.length === 1 ? 'looks' : 'look'} related.{' '}
                                        Want to keep it fresh?
                                    </span>
                                    <span className="essay-flow-memory-action">
                                        {memoryExpanded ? 'Hide' : 'View'}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    className="essay-flow-memory-dismiss"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setMemoryDismissed(true);
                                    }}
                                    aria-label="Dismiss"
                                >
                                    ×
                                </button>
                                {memoryExpanded && (
                                    <ul className="essay-flow-memory-list">
                                        {memoryMatches.map((m) => (
                                            <li
                                                key={m.id}
                                                className="essay-flow-memory-item"
                                            >
                                                <div className="essay-flow-memory-item-topic">
                                                    {m.topic || 'Untitled essay'}
                                                </div>
                                                {m.summary && (
                                                    <div className="essay-flow-memory-item-summary">
                                                        {m.summary}
                                                    </div>
                                                )}
                                                <div className="essay-flow-memory-item-meta">
                                                    <span className="essay-flow-memory-item-date">
                                                        {formatRelativeDate(m.created_at)}
                                                    </span>
                                                    {m.conversation_id && onOpenPastEssay && (
                                                        <button
                                                            type="button"
                                                            className="essay-flow-memory-item-open"
                                                            onClick={() =>
                                                                onOpenPastEssay(m.conversation_id)
                                                            }
                                                        >
                                                            Open →
                                                        </button>
                                                    )}
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                        <div className="essay-flow-history expand">
                            {questions.map((q, i) => {
                                const ex = examples[i];
                                const exVisible = ex && ex.text && !ex.hidden;
                                const isSkipped = skippedQuestions.has(i);
                                return (
                                    <div
                                        key={i}
                                        className={
                                            'essay-flow-exchange ' +
                                            (isSkipped ? 'essay-flow-exchange--skipped' : '')
                                        }
                                    >
                                        <div className="essay-flow-exchange-q-row">
                                            <div className="essay-flow-exchange-q">{q}</div>
                                            {!isSkipped && (
                                                <div className="essay-flow-exchange-q-tools">
                                                    <MicButton
                                                        value={answers[i] || ''}
                                                        onChange={(next) => handleAnswerChange(i, next)}
                                                        disabled={disabled}
                                                        size="sm"
                                                        title="Talk through your answer"
                                                    />
                                                    <button
                                                        type="button"
                                                        className="essay-flow-skip-question"
                                                        onClick={() => handleSkipQuestion(i)}
                                                        disabled={disabled}
                                                        title="Skip this one — you don't have to answer every question"
                                                    >
                                                        Skip
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                        {isSkipped ? (
                                            <div className="essay-flow-skipped-banner">
                                                <span>Skipped — the council won't ask about this.</span>
                                                <button
                                                    type="button"
                                                    className="essay-flow-link essay-flow-link--inline"
                                                    onClick={() => handleUnskipQuestion(i)}
                                                    disabled={disabled}
                                                >
                                                    Undo
                                                </button>
                                            </div>
                                        ) : (
                                            <textarea
                                                value={answers[i] || ''}
                                                onChange={(e) => handleAnswerChange(i, e.target.value)}
                                                placeholder="Type a sentence or two… or tap the mic to talk it through."
                                                rows={2}
                                                disabled={disabled}
                                                className="essay-flow-textarea"
                                                style={{ minHeight: 60 }}
                                            />
                                        )}
                                        {!isSkipped && (
                                        <div className="essay-flow-example-row">
                                            <button
                                                type="button"
                                                className="essay-flow-example-toggle"
                                                onClick={() => handleShowExample(i, q)}
                                                disabled={disabled || (ex && ex.loading)}
                                            >
                                                {ex && ex.loading
                                                    ? 'Thinking…'
                                                    : ex && ex.text
                                                      ? exVisible
                                                          ? 'Hide example'
                                                          : 'Show example'
                                                      : 'Stuck? Show me an example'}
                                            </button>
                                        </div>
                                        )}
                                        {!isSkipped && ex && ex.error && (
                                            <div className="essay-flow-example-error">
                                                {ex.error}
                                            </div>
                                        )}
                                        {!isSkipped && exVisible && (
                                            <div className="essay-flow-example">
                                                <div className="essay-flow-example-label">
                                                    Example — not your answer, just a nudge
                                                </div>
                                                <div className="essay-flow-example-text">
                                                    {ex.text}
                                                </div>
                                                <div className="essay-flow-example-actions">
                                                    <button
                                                        type="button"
                                                        className="essay-flow-example-link"
                                                        onClick={() =>
                                                            handleRegenerateExample(i, q)
                                                        }
                                                        disabled={disabled}
                                                    >
                                                        Try a different angle
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-primary"
                                onClick={handleSubmitAnswers}
                                disabled={disabled || questionsLoading || !allQuestionsHandled}
                                title={
                                    allQuestionsHandled
                                        ? 'Continue to your core idea'
                                        : 'Answer or skip each question to continue'
                                }
                            >
                                {submitting ? 'Saving…' : 'Continue'}
                            </button>
                        </div>
                    </div>
                )}

                {step === 'core_idea' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">Your core idea</h2>
                        <p className="essay-flow-hint">
                            This is the spine the council will write to — synthesized from your
                            topic and answers. Edit anything that doesn't sound like you yet.
                        </p>
                        {coreIdeaLoading ? (
                            <div className="essay-flow-hint" style={{ opacity: 0.8 }}>
                                Drafting your core idea…
                            </div>
                        ) : (
                            <div className="essay-flow-textarea-with-mic">
                                <textarea
                                    ref={coreIdeaRef}
                                    value={coreIdea}
                                    onChange={(e) => setCoreIdea(e.target.value)}
                                    placeholder="Your core idea will appear here once drafted…"
                                    rows={8}
                                    disabled={disabled}
                                    className="essay-flow-textarea"
                                />
                                <div className="essay-flow-textarea-mic">
                                    <MicButton
                                        value={coreIdea}
                                        onChange={setCoreIdea}
                                        disabled={disabled}
                                        size="md"
                                        showLabel
                                        title="Talk through changes to your core idea"
                                    />
                                </div>
                            </div>
                        )}
                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-link"
                                onClick={() => setStep('questions')}
                                disabled={disabled}
                            >
                                ← Back
                            </button>
                            <button
                                type="button"
                                className="essay-flow-primary"
                                onClick={handleApproveCoreIdea}
                                disabled={disabled || coreIdeaLoading || !coreIdea.trim()}
                            >
                                {submitting ? 'Saving…' : 'This works → continue'}
                            </button>
                        </div>
                    </div>
                )}

                {step === 'voice' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">Voice & length</h2>
                        <p className="essay-flow-hint">
                            Last step. The council will lean into the voice you describe here.
                        </p>
                        {onOpenVoiceSettings ? (
                            <p className="essay-flow-hint essay-flow-voice-settings-callout">
                                <button
                                    type="button"
                                    className="essay-flow-link"
                                    onClick={onOpenVoiceSettings}
                                >
                                    Open saved voice rules
                                </button>{' '}
                                <span className="essay-flow-word-target-summary">
                                    — persistent rules and reference paragraphs (Settings → My Voice)
                                    apply to every essay, including this one.
                                </span>
                            </p>
                        ) : null}

                        <div className="essay-flow-section">
                            <div className="essay-flow-section-label">Authors you admire</div>
                            <input
                                type="text"
                                value={authorsText}
                                onChange={(e) => setAuthorsText(e.target.value)}
                                placeholder="e.g. Joan Didion, Ocean Vuong, James Baldwin"
                                disabled={disabled}
                                className="essay-flow-input"
                            />
                            <div className="essay-flow-word-target-summary">
                                Up to 5. Comma-separated. Used as a stylistic anchor — the council
                                won't quote or name them in your essay.
                            </div>
                        </div>

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
                                        : 'Customize the council for this essay'}
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
                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-link"
                                onClick={() => setStep('core_idea')}
                                disabled={disabled}
                            >
                                ← Back
                            </button>
                            <button
                                type="button"
                                className="essay-flow-primary"
                                onClick={handleStartCouncil}
                                disabled={disabled}
                            >
                                {submitting ? 'Saving…' : 'Run the council'}
                            </button>
                        </div>
                    </div>
                )}

                {step === 'draft' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">Paste your draft</h2>
                        <p className="essay-flow-hint">
                            Rough is fine — bullet points, half-sentences, anything you have. The
                            council will refine it without flattening your voice.
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
                        </div>

                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-link"
                                onClick={() => setStep('topic')}
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
            </div>
        </div>
    );
}
