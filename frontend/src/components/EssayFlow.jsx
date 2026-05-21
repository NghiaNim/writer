import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import CouncilConfig from './CouncilConfig';
import MicButton from './common/MicButton';
import CoreIdeaBullets from './CoreIdeaBullets';
import './EssayFlow.css';

// Word-target presets for the Step 4 picker. Tuned for college admissions /
// statement-of-purpose use cases. The label is the number; the per-chip
// subtitle was dropped in favor of a single explanatory hint underneath
// the row — four subtitles competing for attention read SaaS-y, one quiet
// hint reads minimal.
const WORD_TARGET_PRESETS = [
    { value: 250, label: '250' },
    { value: 500, label: '500' },
    { value: 650, label: '650' },
    { value: 1000, label: '1000' },
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

// Reflection prompts shown on the brainstorm lane (the "I don't have a
// topic yet" path). Each one is deliberately open and conversational —
// students answer with whatever's actually on their mind, and the
// Flash brainstorm endpoint pulls 3-4 specific topic candidates out
// of those answers. The prompts themselves shouldn't telegraph an
// expected answer shape, so they read like a real conversation.
const BRAINSTORM_PROMPTS = [
    "What's something you keep arguing about with yourself? (Or with someone else.)",
    "Tell me about a moment from the last year where something quietly shifted — a small thing you've thought about since.",
    "What's a story your friends would say you tell too often? And what would surprise them about why you keep telling it?",
];

// Common audiences as quick-pick chips on the topic step. The free-text
// input stays available alongside — these are starting points, not the
// only options. Order is rough-frequency for the user base we expect:
// admissions essays first, then academic, then publishing, then journal.
const AUDIENCE_PRESETS = [
    'An admissions officer',
    'A graduate admissions committee',
    'A creative writing professor',
    'A magazine editor',
    'A general reader',
    'Yourself (a journal entry)',
];

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

function buildInteractiveMessage({ topic, audience, qa, coreIdea, authors, timeline }) {
    const briefLines = qa
        .map(({ question, answer }) => `- Q: ${question}\n  A: ${(answer || '').trim()}`)
        .join('\n');
    const timelineBlock = (() => {
        if (!Array.isArray(timeline) || timeline.length === 0) return '';
        const lines = timeline
            .map(({ when, what }, i) => {
                const w = (when || '').trim();
                const t = (what || '').trim();
                if (!t) return null;
                const prefix = w ? `${i + 1}. ${w} — ${t}` : `${i + 1}. ${t}`;
                return prefix;
            })
            .filter(Boolean);
        if (lines.length === 0) return '';
        return (
            'STORY TIMELINE (events in the order the user wants them narrated; do not reorder unless a clear structural purpose justifies it):\n' +
            lines.join('\n')
        );
    })();
    return [
        `TOPIC: ${topic}`,
        audience ? `AUDIENCE: ${audience}` : '',
        '',
        coreIdea ? 'CORE IDEA:' : '',
        coreIdea || '',
        '',
        timelineBlock,
        timelineBlock ? '' : null,
        'USER BRIEF (collected from a short prep conversation):',
        briefLines || '(no notes)',
        authors && authors.length
            ? `\nAUTHORS THE USER ADMIRES (lean toward this stylistic register without naming them in the essay): ${authors.join(', ')}`
            : '',
    ]
        .filter((line) => line !== null && line !== undefined && line !== false)
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
    // Brainstorm lane state — only used when the user took the "I don't
    // have a topic yet" path. brainstormReflections is keyed by prompt
    // index so the user's answers persist if they navigate around.
    const [brainstormReflections, setBrainstormReflections] = useState({});
    const [topicCandidates, setTopicCandidates] = useState([]);
    const [brainstormLoading, setBrainstormLoading] = useState(false);

    // questions: TypedQuestion[] from the backend.
    //   { question_id, kind: 'text'|'examples_text'|'choice'|'multi',
    //     section, question, subtext?, placeholder?, examples?,
    //     options?, max_select?, min_select? }
    // sections: [{ id, label }] — render order. Empty = flat list.
    const [questions, setQuestions] = useState([]);
    const [sections, setSections] = useState([]);
    const [questionsLoading, setQuestionsLoading] = useState(false);
    // Question index currently being swapped via the regenerate endpoint
    // — used for the spinner state on the Swap button.
    const [swappingIdx, setSwappingIdx] = useState(null);
    // answers[idx] is a string for text/examples_text/choice questions OR
    // an array of option strings for multi questions.
    const [answers, setAnswers] = useState({});
    // Questions the user has intentionally chosen to skip. Continue is
    // gated on every question being either answered OR explicitly
    // skipped, so users move forward without being forced to answer
    // each one.
    const [skippedQuestions, setSkippedQuestions] = useState(new Set());

    // Step 3 state
    const [coreIdea, setCoreIdea] = useState('');
    const [coreIdeaLoading, setCoreIdeaLoading] = useState(false);

    // Story-timeline step — students list the events they want to mention,
    // each with an optional time marker. The order they end up in here is
    // the order the council should respect in the essay (paired with the
    // CHRONOLOGY_BLOCK directive on the backend). Empty list = the user
    // doesn't have one; the timeline block is omitted from the brief.
    const [timelineEvents, setTimelineEvents] = useState([]);
    const [newTimelineWhen, setNewTimelineWhen] = useState('');
    const [newTimelineWhat, setNewTimelineWhat] = useState('');

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

    useEffect(() => {
        if (step === 'topic') topicRef.current?.focus();
        if (step === 'draft') draftRef.current?.focus();
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
                setSections(Array.isArray(res?.sections) ? res.sections : []);
            } catch (err) {
                console.warn('intake/questions failed:', err);
                setSections([
                    { id: 'positioning', label: 'How you want them to see you' },
                    { id: 'story', label: 'A specific moment' },
                ]);
                setQuestions([
                    {
                        question_id: 'fallback-1',
                        kind: 'text',
                        section: 'positioning',
                        question: "What's the first thing you remember about this — a sound, a face, a sentence someone said?",
                    },
                    {
                        question_id: 'fallback-2',
                        kind: 'text',
                        section: 'positioning',
                        question: "What's the part of this you almost didn't put in the essay?",
                    },
                    {
                        question_id: 'fallback-3',
                        kind: 'text',
                        section: 'story',
                        question: "Who in your life would roll their eyes at this — and why are they almost right?",
                    },
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

    // ── Brainstorm lane ─────────────────────────────────────────────────
    // Used when a student doesn't have a topic yet. They answer 2-3 open
    // reflection prompts, we surface candidate topics via Flash, they pick
    // one and the flow re-enters the normal topic step with the topic
    // prefilled. The brainstorm step is OFF the main 4-step path — the
    // stepper hides on it intentionally since this is a side-lane.

    const handleStartBrainstorm = () => {
        setError(null);
        setStep('brainstorm');
        setTopicCandidates([]);
    };

    const handleBrainstormReflectionChange = (idx, value) => {
        setBrainstormReflections((prev) => ({ ...prev, [idx]: value }));
    };

    const handleBrainstormGenerate = async () => {
        setError(null);
        const reflections = BRAINSTORM_PROMPTS.map((prompt, i) => ({
            prompt,
            answer: (brainstormReflections[i] || '').trim(),
        })).filter((r) => r.answer);
        if (reflections.length === 0) {
            setError('Answer at least one prompt — even a sentence or two gives me something to work with.');
            return;
        }
        setBrainstormLoading(true);
        try {
            const res = await api.intake.brainstormTopics({ reflections });
            const list = Array.isArray(res?.topics) ? res.topics : [];
            if (list.length === 0) {
                setError("Couldn't pull out topics from those answers — try adding more concrete detail.");
                return;
            }
            setTopicCandidates(list);
        } catch (e) {
            setError(e.message || 'Failed to brainstorm topics.');
        } finally {
            setBrainstormLoading(false);
        }
    };

    const handlePickBrainstormTopic = (candidateTopic) => {
        setTopic(candidateTopic);
        setStep('topic');
        // Drop the candidates so going back to brainstorm starts fresh
        // visually, but keep the reflection answers in case the user
        // wants a different topic from the same answers later.
        setTopicCandidates([]);
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
                ...(audience.trim() ? { audience: audience.trim() } : {}),
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
    // True when a typed answer "counts" as handled — strings need real
    // content, multi-select arrays need at least one chosen option.
    const isAnswerFilled = (q, value) => {
        if (q?.kind === 'multi') {
            return Array.isArray(value) && value.length > 0;
        }
        if (typeof value === 'string') return value.trim().length > 0;
        return false;
    };

    const allQuestionsHandled = useMemo(() => {
        if (!questions.length) return false;
        return questions.every(
            (q, i) => isAnswerFilled(q, answers[i]) || skippedQuestions.has(i)
        );
    }, [questions, answers, skippedQuestions]);

    const handleAnswerChange = (idx, value) => {
        setAnswers((prev) => ({ ...prev, [idx]: value }));
        // Typing into a previously-skipped question un-skips it
        // automatically — the user clearly has something to say.
        const q = questions[idx];
        if (skippedQuestions.has(idx) && isAnswerFilled(q, value)) {
            setSkippedQuestions((prev) => {
                const next = new Set(prev);
                next.delete(idx);
                return next;
            });
        }
    };

    // Toggle one option on a multi-select question. Enforces max_select by
    // dropping the oldest pick when the user crosses the cap so they don't
    // have to manually deselect first — feels more like a coach saying
    // "OK pick a different one" than a form yelling at them.
    const handleToggleMulti = (idx, option) => {
        const q = questions[idx];
        if (!q || q.kind !== 'multi') return;
        const max = Math.max(1, q.max_select || 1);
        setAnswers((prev) => {
            const current = Array.isArray(prev[idx]) ? prev[idx] : [];
            let next;
            if (current.includes(option)) {
                next = current.filter((o) => o !== option);
            } else {
                next = [...current, option];
                while (next.length > max) next.shift();
            }
            return { ...prev, [idx]: next };
        });
        if (skippedQuestions.has(idx)) {
            setSkippedQuestions((prev) => {
                const nextSet = new Set(prev);
                nextSet.delete(idx);
                return nextSet;
            });
        }
    };

    // Tap an example chip on an examples_text question to seed the
    // textarea. Replaces any existing draft so the chip behaves like
    // "show me an example to start from" — the user edits from there.
    const handlePickExample = (idx, text) => {
        handleAnswerChange(idx, text);
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

    // Replace one intake question with a fresh one. Calls the regenerate
    // endpoint with the full current question set so the model can pick a
    // different angle. Clears any partial answer + skipped state for that
    // index, since the new question is a different prompt.
    const handleSwapQuestion = async (idx) => {
        if (swappingIdx !== null) return;
        const rejected = questions[idx];
        const rejectedText = rejected?.question || '';
        setSwappingIdx(idx);
        setError(null);
        try {
            const res = await api.intake.regenerateQuestion({
                topic: topic.trim(),
                audience: audience.trim(),
                alreadyAsked: questions
                    .filter((q, i) => i !== idx && q?.question)
                    .map((q) => q.question),
                rejectedQuestion: rejectedText,
            });
            const fresh = res?.question;
            if (!fresh || !fresh.question_id || !fresh.question) {
                setError("Couldn't find a different angle — try the Skip button instead.");
                return;
            }
            setQuestions((prev) => {
                const next = [...prev];
                next[idx] = fresh;
                return next;
            });
            // The old answer doesn't apply to the new question.
            setAnswers((prev) => {
                if (!prev[idx]) return prev;
                const next = { ...prev };
                delete next[idx];
                return next;
            });
            setSkippedQuestions((prev) => {
                if (!prev.has(idx)) return prev;
                const next = new Set(prev);
                next.delete(idx);
                return next;
            });
            setExamples((prev) => {
                if (!prev[idx]) return prev;
                const next = { ...prev };
                delete next[idx];
                return next;
            });
        } catch (e) {
            setError(e.message || 'Failed to swap question.');
        } finally {
            setSwappingIdx(null);
        }
    };

    // Turn one typed answer into the plain "Q: ... A: ..." string the
    // council prompt expects. Multi-select picks are joined with semicolons
    // so they read as a clear list ("solves problems; notices small
    // details") rather than as one comma-separated blob the model might
    // mis-parse as a single phrase.
    const serializeAnswer = (q, value) => {
        if (q?.kind === 'multi') {
            if (!Array.isArray(value) || value.length === 0) return '';
            return value.map((o) => (o || '').trim()).filter(Boolean).join('; ');
        }
        if (typeof value === 'string') return value.trim();
        return '';
    };

    const buildAnsweredQa = () =>
        questions
            .map((q, i) => ({
                question: q?.question || '',
                answer: serializeAnswer(q, answers[i]),
            }))
            .filter((item) => item.question && item.answer);

    const handleSubmitAnswers = async () => {
        setError(null);
        const answeredCount = buildAnsweredQa().length;
        if (answeredCount < 1) {
            setError("Answer at least one question — even one short reply gives the council something concrete to work with.");
            return;
        }
        await advanceToCoreIdea();
    };

    const advanceToCoreIdea = async () => {
        setSubmitting(true);
        try {
            const qa = buildAnsweredQa();
            await api.sessions.update(session.id, {
                conversation: qa,
                ...(audience.trim() ? { audience: audience.trim() } : {}),
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
            setStep('timeline');
        } catch (err) {
            setError(err.message || 'Could not save the core idea.');
        } finally {
            setSubmitting(false);
        }
    };

    // ── Timeline handlers ───────────────────────────────────────────────
    // The timeline is an ordered list of {when, what} events. `when` is
    // optional — students who don't know the exact date can leave it
    // blank. Order matters: the council will narrate events in the
    // order they appear here.
    const handleAddTimelineEvent = () => {
        const what = newTimelineWhat.trim();
        if (!what) return;
        setTimelineEvents((prev) => [
            ...prev,
            { when: newTimelineWhen.trim(), what },
        ]);
        setNewTimelineWhen('');
        setNewTimelineWhat('');
    };

    const handleRemoveTimelineEvent = (idx) => {
        setTimelineEvents((prev) => prev.filter((_, i) => i !== idx));
    };

    const handleMoveTimelineEvent = (idx, direction) => {
        setTimelineEvents((prev) => {
            const next = [...prev];
            const target = idx + direction;
            if (target < 0 || target >= next.length) return prev;
            [next[idx], next[target]] = [next[target], next[idx]];
            return next;
        });
    };

    // Persist the timeline alongside the Q&A so a refresh between
    // step 3 (timeline) and step 4 (voice) doesn't drop everything the
    // student just typed. We keep the Q&A entries Q&A-shaped and append
    // a single sentinel entry the council message builder ignores.
    const persistTimelineToSession = async (events) => {
        if (!session?.id) return;
        const qa = questions
            .map((q, i) => ({ question: q, answer: (answers[i] || '').trim() }))
            .filter((item) => item.answer);
        const conversation = events.length
            ? [...qa, { kind: 'timeline', events }]
            : qa;
        try {
            await api.sessions.update(session.id, { conversation });
        } catch (e) {
            // Non-blocking — the timeline still lives in component state
            // and will be sent to the council. We only lose it if the
            // user refreshes before clicking Start.
            console.warn('Failed to persist timeline to session:', e);
        }
    };

    const handleSubmitTimeline = async () => {
        setError(null);
        await persistTimelineToSession(timelineEvents);
        setStep('voice');
    };

    const handleSkipTimeline = async () => {
        setError(null);
        setTimelineEvents([]);
        await persistTimelineToSession([]);
        setStep('voice');
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

            const qa = buildAnsweredQa();
            const message = buildInteractiveMessage({
                topic: topic.trim(),
                audience: audience.trim(),
                qa,
                coreIdea: coreIdea.trim(),
                authors,
                timeline: timelineEvents,
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
    const STEP_ORDER = ['topic', 'questions', 'core_idea', 'timeline', 'voice'];
    const STEP_LABELS = {
        topic: 'Topic & audience',
        questions: 'A few questions',
        core_idea: 'Your core idea',
        timeline: 'Story timeline',
        voice: 'Voice & ready',
    };
    const stepIndex = STEP_ORDER.indexOf(step);
    const showStepper = stepIndex >= 0;

    return (
        <div className="essay-flow essay-flow--coffee">
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
                        <span>{topic}</span>
                        {audience && (
                            <>
                                <span
                                    className="essay-flow-topic-chip-arrow"
                                    aria-hidden="true"
                                >
                                    →
                                </span>
                                <span>{audience}</span>
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
                        <h1 className="essay-flow-question">
                            Let's start with what you're after.
                        </h1>
                        <p className="essay-flow-warm-subline">
                            One short sentence. The first pour is always rough — that's fine.
                        </p>

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
                            <button
                                type="button"
                                className="essay-flow-link essay-flow-link--soft"
                                onClick={handleStartBrainstorm}
                                disabled={disabled}
                            >
                                I don't have a topic yet — help me find one →
                            </button>
                        </div>

                        <div className="essay-flow-field">
                            <label htmlFor="essay-flow-audience" className="essay-flow-label">
                                Audience
                            </label>
                            <p className="essay-flow-field-hint">
                                Who's reading this? Be specific — the answer changes everything.
                            </p>
                            <div
                                className="essay-flow-audience-chips"
                                role="group"
                                aria-label="Common audiences"
                            >
                                {AUDIENCE_PRESETS.map((preset) => {
                                    const isActive =
                                        audience.trim().toLowerCase() ===
                                        preset.toLowerCase();
                                    return (
                                        <button
                                            key={preset}
                                            type="button"
                                            className={
                                                'essay-flow-chip ' +
                                                (isActive ? 'essay-flow-chip--active' : '')
                                            }
                                            onClick={() => setAudience(preset)}
                                            disabled={disabled}
                                        >
                                            {preset}
                                        </button>
                                    );
                                })}
                            </div>
                            <input
                                id="essay-flow-audience"
                                type="text"
                                value={audience}
                                onChange={(e) => setAudience(e.target.value)}
                                placeholder="Or type your own — e.g. a magazine editor, your future self"
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

                {step === 'brainstorm' && (
                    <div className="essay-flow-step">
                        <h1 className="essay-flow-question">Let's find your topic together</h1>
                        <p className="essay-flow-hint">
                            Answer a couple honestly. These aren't the essay — they help us find it.
                        </p>

                        <div className="essay-flow-history">
                            {BRAINSTORM_PROMPTS.map((prompt, i) => (
                                <div key={i} className="essay-flow-exchange">
                                    <div className="essay-flow-exchange-q-row">
                                        <div className="essay-flow-exchange-q">{prompt}</div>
                                        <div className="essay-flow-exchange-q-tools">
                                            <MicButton
                                                value={brainstormReflections[i] || ''}
                                                onChange={(next) =>
                                                    handleBrainstormReflectionChange(i, next)
                                                }
                                                disabled={disabled || brainstormLoading}
                                                size="sm"
                                                title="Talk through this — it's faster than typing"
                                            />
                                        </div>
                                    </div>
                                    <textarea
                                        value={brainstormReflections[i] || ''}
                                        onChange={(e) =>
                                            handleBrainstormReflectionChange(i, e.target.value)
                                        }
                                        placeholder="A few sentences. Be specific. No one else will read this."
                                        rows={3}
                                        disabled={disabled || brainstormLoading}
                                        className="essay-flow-textarea"
                                        style={{ minHeight: 90 }}
                                    />
                                </div>
                            ))}
                        </div>

                        {topicCandidates.length > 0 && (
                            <div className="essay-flow-brainstorm-results">
                                <div className="essay-flow-brainstorm-results-label">
                                    Candidate topics
                                </div>
                                <p className="essay-flow-hint" style={{ marginTop: 0 }}>
                                    Pick the one that makes you uncomfortable in the right way.
                                </p>
                                <div className="essay-flow-brainstorm-list">
                                    {topicCandidates.map((c, i) => (
                                        <button
                                            key={i}
                                            type="button"
                                            className="essay-flow-brainstorm-card"
                                            onClick={() => handlePickBrainstormTopic(c.topic)}
                                            disabled={disabled || brainstormLoading}
                                        >
                                            <span className="essay-flow-brainstorm-topic">
                                                {c.topic}
                                            </span>
                                            {c.reason && (
                                                <span className="essay-flow-brainstorm-reason">
                                                    {c.reason}
                                                </span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {error && <div className="essay-flow-error">{error}</div>}

                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-link"
                                onClick={() => setStep('topic')}
                                disabled={disabled || brainstormLoading}
                            >
                                ← Back to typing my own
                            </button>
                            <button
                                type="button"
                                className="essay-flow-primary"
                                onClick={handleBrainstormGenerate}
                                disabled={disabled || brainstormLoading}
                            >
                                {brainstormLoading
                                    ? 'Thinking…'
                                    : topicCandidates.length > 0
                                        ? 'Try again with these answers'
                                        : 'Show me topics'}
                            </button>
                        </div>
                    </div>
                )}

                {step === 'questions' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">A few questions to make this sound like you</h2>
                        <p className="essay-flow-hint">
                            Short answers. Skip or swap any that don't feel right.
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
                        {questions.length > 0 && (() => {
                            // Group questions by section so each section's
                            // header renders once above its questions. If no
                            // sections came back, render a single flat group.
                            const groups = sections.length
                                ? sections.map((section) => ({
                                      section,
                                      items: questions
                                          .map((q, i) => ({ q, i }))
                                          .filter(({ q }) => q?.section === section.id),
                                  }))
                                : [{ section: null, items: questions.map((q, i) => ({ q, i })) }];

                            const renderQuestion = ({ q, i }) => {
                                if (!q) return null;
                                const ex = examples[i];
                                const exVisible = ex && ex.text && !ex.hidden;
                                const isSkipped = skippedQuestions.has(i);
                                const isSwappingThis = swappingIdx === i;
                                const kind = q.kind || 'text';
                                const value = answers[i];
                                const textValue = typeof value === 'string' ? value : '';
                                const multiValue = Array.isArray(value) ? value : [];
                                const canMic = kind === 'text' || kind === 'examples_text';
                                const canShowExample = kind === 'text';
                                const showExampleChips =
                                    kind === 'examples_text' && Array.isArray(q.examples) && q.examples.length > 0;

                                return (
                                    <div
                                        key={q.question_id || i}
                                        className={
                                            'essay-flow-exchange ' +
                                            (isSkipped ? 'essay-flow-exchange--skipped' : '')
                                        }
                                    >
                                        <div className="essay-flow-exchange-q-row">
                                            <div className="essay-flow-exchange-q">
                                                <span className="essay-flow-exchange-q-number">
                                                    {i + 1}.
                                                </span>{' '}
                                                {q.question}
                                            </div>
                                            {!isSkipped && (
                                                <div className="essay-flow-exchange-q-tools">
                                                    {canMic && (
                                                        <MicButton
                                                            value={textValue}
                                                            onChange={(next) => handleAnswerChange(i, next)}
                                                            disabled={disabled || isSwappingThis}
                                                            size="sm"
                                                            title="Talk through your answer"
                                                        />
                                                    )}
                                                    <button
                                                        type="button"
                                                        className="essay-flow-skip-question"
                                                        onClick={() => handleSwapQuestion(i)}
                                                        disabled={disabled || isSwappingThis}
                                                        title="This question doesn't fit — give me a different one"
                                                    >
                                                        {isSwappingThis ? 'Swapping…' : 'Swap'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="essay-flow-skip-question"
                                                        onClick={() => handleSkipQuestion(i)}
                                                        disabled={disabled || isSwappingThis}
                                                        title="Skip this one — you don't have to answer every question"
                                                    >
                                                        Skip
                                                    </button>
                                                </div>
                                            )}
                                        </div>

                                        {q.subtext && !isSkipped && (
                                            <div className="essay-flow-exchange-subtext">
                                                {q.subtext}
                                            </div>
                                        )}

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
                                        ) : kind === 'multi' ? (
                                            <div className="essay-flow-options" role="group">
                                                {(q.options || []).map((option) => {
                                                    const selected = multiValue.includes(option);
                                                    return (
                                                        <button
                                                            type="button"
                                                            key={option}
                                                            className={
                                                                'essay-flow-option ' +
                                                                (selected ? 'essay-flow-option--selected' : '')
                                                            }
                                                            onClick={() => handleToggleMulti(i, option)}
                                                            disabled={disabled || isSwappingThis}
                                                            aria-pressed={selected}
                                                        >
                                                            <span className="essay-flow-option-tick" aria-hidden="true">
                                                                {selected ? '✓' : ''}
                                                            </span>
                                                            <span className="essay-flow-option-label">{option}</span>
                                                        </button>
                                                    );
                                                })}
                                                <div className="essay-flow-option-hint">
                                                    Pick up to {q.max_select || 1}.{' '}
                                                    {multiValue.length > 0 &&
                                                        `${multiValue.length} chosen.`}
                                                </div>
                                            </div>
                                        ) : kind === 'choice' ? (
                                            <div className="essay-flow-options" role="radiogroup">
                                                {(q.options || []).map((option) => {
                                                    const selected = textValue === option;
                                                    return (
                                                        <button
                                                            type="button"
                                                            key={option}
                                                            className={
                                                                'essay-flow-option ' +
                                                                (selected ? 'essay-flow-option--selected' : '')
                                                            }
                                                            onClick={() => handleAnswerChange(i, option)}
                                                            disabled={disabled || isSwappingThis}
                                                            aria-pressed={selected}
                                                            role="radio"
                                                            aria-checked={selected}
                                                        >
                                                            <span className="essay-flow-option-tick" aria-hidden="true">
                                                                {selected ? '●' : ''}
                                                            </span>
                                                            <span className="essay-flow-option-label">{option}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                            <textarea
                                                value={textValue}
                                                onChange={(e) => handleAnswerChange(i, e.target.value)}
                                                placeholder={
                                                    q.placeholder ||
                                                    'One or two sentences is plenty. Tap the mic to talk it through.'
                                                }
                                                rows={3}
                                                disabled={disabled || isSwappingThis}
                                                className="essay-flow-textarea"
                                                style={{ minHeight: 90 }}
                                            />
                                        )}

                                        {showExampleChips && !isSkipped && (
                                            <div className="essay-flow-example-chips">
                                                {q.examples.map((sample) => (
                                                    <button
                                                        type="button"
                                                        key={sample}
                                                        className="essay-flow-example-chip"
                                                        onClick={() => handlePickExample(i, sample)}
                                                        disabled={disabled || isSwappingThis}
                                                        title="Use as a starting point — edit from here"
                                                    >
                                                        {sample}
                                                    </button>
                                                ))}
                                            </div>
                                        )}

                                        {canShowExample && !isSkipped && (
                                            <div className="essay-flow-example-row">
                                                <button
                                                    type="button"
                                                    className="essay-flow-example-toggle"
                                                    onClick={() => handleShowExample(i, q.question)}
                                                    disabled={disabled || isSwappingThis || (ex && ex.loading)}
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
                                        {canShowExample && !isSkipped && ex && ex.error && (
                                            <div className="essay-flow-example-error">
                                                {ex.error}
                                            </div>
                                        )}
                                        {canShowExample && !isSkipped && exVisible && (
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
                                                        onClick={() => handleRegenerateExample(i, q.question)}
                                                        disabled={disabled}
                                                    >
                                                        Try a different angle
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            };

                            return (
                                <div className="essay-flow-history">
                                    {groups.map(({ section, items }, gi) => {
                                        if (items.length === 0) return null;
                                        return (
                                            <div key={section?.id || `group-${gi}`} className="essay-flow-question-section">
                                                {section && (
                                                    <div className="essay-flow-question-section-header">
                                                        {section.label}
                                                    </div>
                                                )}
                                                {items.map(renderQuestion)}
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })()}

                        {error && <div className="essay-flow-error">{error}</div>}

                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-primary"
                                onClick={handleSubmitAnswers}
                                disabled={
                                    disabled || questionsLoading || !allQuestionsHandled
                                }
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
                        <h2 className="essay-flow-question">The shape of it</h2>
                        <p className="essay-flow-hint">
                            The spine the council will write to. Edit, reorder, or drop any beat.
                        </p>
                        {coreIdeaLoading ? (
                            <div className="essay-flow-hint" style={{ opacity: 0.8 }}>
                                Pulling the shape of your idea apart into beats…
                            </div>
                        ) : (
                            <CoreIdeaBullets
                                value={coreIdea}
                                onChange={setCoreIdea}
                                disabled={disabled}
                            />
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

                {step === 'timeline' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">Story timeline</h2>
                        <p className="essay-flow-hint">
                            Optional. List events in the order they happened — the council will respect the sequence.
                        </p>

                        {timelineEvents.length > 0 && (
                            <ol className="essay-flow-timeline-list">
                                {timelineEvents.map((evt, idx) => (
                                    <li key={idx} className="essay-flow-timeline-row">
                                        <div className="essay-flow-timeline-arrows">
                                            <button
                                                type="button"
                                                className="essay-flow-timeline-arrow"
                                                onClick={() => handleMoveTimelineEvent(idx, -1)}
                                                disabled={disabled || idx === 0}
                                                aria-label="Move earlier"
                                                title="Move earlier"
                                            >
                                                ▲
                                            </button>
                                            <button
                                                type="button"
                                                className="essay-flow-timeline-arrow"
                                                onClick={() => handleMoveTimelineEvent(idx, 1)}
                                                disabled={disabled || idx === timelineEvents.length - 1}
                                                aria-label="Move later"
                                                title="Move later"
                                            >
                                                ▼
                                            </button>
                                        </div>
                                        <div className="essay-flow-timeline-body">
                                            {evt.when && (
                                                <div className="essay-flow-timeline-when">
                                                    {evt.when}
                                                </div>
                                            )}
                                            <div className="essay-flow-timeline-what">
                                                {evt.what}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="essay-flow-timeline-remove"
                                            onClick={() => handleRemoveTimelineEvent(idx)}
                                            disabled={disabled}
                                            title="Remove this event"
                                            aria-label="Remove"
                                        >
                                            ×
                                        </button>
                                    </li>
                                ))}
                            </ol>
                        )}

                        <div className="essay-flow-timeline-add">
                            <input
                                type="text"
                                value={newTimelineWhen}
                                onChange={(e) => setNewTimelineWhen(e.target.value)}
                                placeholder="When (optional)"
                                disabled={disabled}
                                className="essay-flow-input essay-flow-timeline-when-input"
                                maxLength={80}
                            />
                            <textarea
                                value={newTimelineWhat}
                                onChange={(e) => setNewTimelineWhat(e.target.value)}
                                placeholder="What happened?"
                                disabled={disabled}
                                className="essay-flow-textarea"
                                rows={2}
                                style={{ minHeight: 60 }}
                                maxLength={500}
                                onKeyDown={(e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                        e.preventDefault();
                                        handleAddTimelineEvent();
                                    }
                                }}
                            />
                            <div className="essay-flow-timeline-add-actions">
                                <button
                                    type="button"
                                    className="essay-flow-secondary"
                                    onClick={handleAddTimelineEvent}
                                    disabled={disabled || !newTimelineWhat.trim()}
                                >
                                    + Add
                                </button>
                            </div>
                        </div>

                        {error && <div className="essay-flow-error">{error}</div>}

                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-link"
                                onClick={handleSkipTimeline}
                                disabled={disabled}
                            >
                                Skip this step
                            </button>
                            <button
                                type="button"
                                className="essay-flow-primary"
                                onClick={handleSubmitTimeline}
                                disabled={disabled}
                            >
                                Continue
                            </button>
                        </div>
                    </div>
                )}

                {step === 'voice' && (
                    <div className="essay-flow-step">
                        <h2 className="essay-flow-question">Voice & length</h2>
                        {onOpenVoiceSettings ? (
                            <p className="essay-flow-voice-rules-link">
                                <button
                                    type="button"
                                    className="essay-flow-link"
                                    onClick={onOpenVoiceSettings}
                                >
                                    Open saved voice rules →
                                </button>
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
                                Up to 5 — stylistic anchors, never named in the essay.
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
                                </div>
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
                                        ? 'Hide council'
                                        : 'Customize council'}
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
                                onClick={() => setStep('timeline')}
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
                            Rough is fine. The council won't flatten your voice.
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
