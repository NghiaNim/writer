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

// Common audiences as quick-pick chips on the topic step. Reframed around
// college-admissions writing since that's the primary use case — high-
// school seniors applying to undergrad. Each chip primes the council to
// write for a specific reader (a Common App reader scanning 50 essays a
// day reads differently from a "why this school" committee). Free-text
// input stays available for anything else.
const AUDIENCE_PRESETS = [
    'Common App personal statement',
    '"Why this school" supplemental',
    '"Why this major" supplemental',
    'Activity / extracurricular essay',
    'Community / identity supplemental',
    'Transfer or scholarship essay',
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
    initialSession = null,
    // Called whenever this session's row changes meaningfully (created,
    // step transition, autosaved content). App uses it to refresh the
    // sidebar's drafts-in-progress list so the step label + timestamp
    // stay in sync with what the user is doing right now.
    onSessionChanged,
}) {
    // Steps: 'topic' -> 'questions' -> 'core_idea' -> 'voice' (-> submit)
    //                  | 'draft' (alternate path from Step 1)
    // When `initialSession` is provided (sidebar resume), seed every piece
    // of state from the persisted row so the user lands exactly where they
    // left off. The component re-mounts (via `key` bump in App.jsx) when
    // the user picks a different draft, so we treat initialSession as
    // one-shot at construction time — no useEffect that re-syncs later.
    //
    // We DERIVE the step from data when the persisted column is null
    // (migration 010 not applied, or row created before the column
    // existed). Mirror of `_derive_step_from_row` in backend/sessions.py
    // so behavior matches whether you resume via direct GET or via the
    // list-endpoint snapshot.
    const _deriveStepFromSession = (s) => {
        if (!s) return 'topic';
        if (s.step) return s.step;
        if ((s.status || '').toLowerCase() === 'ready') return 'voice';
        const convo = Array.isArray(s.conversation) ? s.conversation : [];
        let hasTimeline = false;
        let hasQA = false;
        for (const item of convo) {
            if (!item || typeof item !== 'object') continue;
            if (item.kind === 'timeline' && Array.isArray(item.events) && item.events.length > 0) {
                hasTimeline = true;
            } else if (item.question != null) {
                hasQA = true;
            }
        }
        if (hasTimeline) return 'voice';
        if ((s.core_idea || '').trim()) return 'timeline';
        if (hasQA) return 'core_idea';
        return 'topic';
    };
    const [step, setStep] = useState(_deriveStepFromSession(initialSession));

    // Persisted session row (created on Step 1 submit, or seeded from the
    // sidebar resume click).
    const [session, setSession] = useState(initialSession || null);

    // Step 1 state — seeded from a resumed session so the user can edit
    // their original topic + audience instead of seeing a blank form.
    const [topic, setTopic] = useState(initialSession?.topic || '');
    const [audience, setAudience] = useState(initialSession?.audience || '');

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
    //
    // Hydration from a resumed session: the persisted `conversation` array
    // alternates between Q&A items (`{question, answer}`) and an optional
    // timeline sentinel (`{kind: 'timeline', events}`). The `question`
    // field may be a string (older persistence path) OR a full TypedQuestion
    // object (newer path that runs at timeline step). We normalise both
    // into a TypedQuestion list and a parallel answers map.
    const _hydrateQA = (() => {
        if (!initialSession?.conversation || !Array.isArray(initialSession.conversation)) {
            return { questions: [], answers: {}, timeline: [] };
        }
        const qs = [];
        const ans = {};
        let timeline = [];
        let i = 0;
        for (const item of initialSession.conversation) {
            if (!item || typeof item !== 'object') continue;
            if (item.kind === 'timeline' && Array.isArray(item.events)) {
                timeline = item.events;
                continue;
            }
            const q = item.question;
            const a = item.answer;
            if (q == null) continue;
            if (typeof q === 'string') {
                qs.push({
                    question_id: `resumed-${i}`,
                    kind: 'text',
                    section: 'positioning',
                    question: q,
                });
            } else if (typeof q === 'object') {
                qs.push({
                    question_id: q.question_id || `resumed-${i}`,
                    kind: q.kind || 'text',
                    section: q.section || 'positioning',
                    question: q.question || '',
                    ...(q.subtext ? { subtext: q.subtext } : {}),
                    ...(q.placeholder ? { placeholder: q.placeholder } : {}),
                    ...(q.examples ? { examples: q.examples } : {}),
                    ...(q.options ? { options: q.options } : {}),
                    ...(q.max_select ? { max_select: q.max_select } : {}),
                    ...(q.min_select ? { min_select: q.min_select } : {}),
                });
            } else {
                continue;
            }
            if (typeof a === 'string') ans[i] = a;
            i += 1;
        }
        return { questions: qs, answers: ans, timeline };
    })();

    const [questions, setQuestions] = useState(_hydrateQA.questions);
    const [sections, setSections] = useState(() => {
        // If we have hydrated questions, default to a generic section
        // header so they render under a label; the actual sections are
        // re-fetched only when the user clicks ↻ Get fresh questions.
        if (_hydrateQA.questions.length === 0) return [];
        const sectionIds = new Set(_hydrateQA.questions.map((q) => q.section).filter(Boolean));
        const known = [
            { id: 'positioning', label: 'How you want admissions to see you' },
            { id: 'direction', label: "Where you're pointed" },
            { id: 'story', label: 'A real moment, place, or thing' },
            { id: 'tactics', label: 'Wrap-up' },
        ];
        return known.filter((s) => sectionIds.has(s.id));
    });
    const [questionsLoading, setQuestionsLoading] = useState(false);
    // True between "stream opened" and "stream complete or error". We
    // intentionally keep this OFF the `disabled` chain — inputs stay
    // interactive while later questions are still arriving so users can
    // start answering the first question the moment it appears.
    const [questionsStreaming, setQuestionsStreaming] = useState(false);
    // Snapshot of the topic+audience the last time we streamed questions,
    // and of the qa signature the last time we generated the core idea.
    // Drives the "↻ Regenerate" buttons' enabled / accent state so the
    // UI can tell users when their inputs have drifted from what was
    // last computed without silently nuking their work.
    const [lastQuestionsKey, setLastQuestionsKey] = useState('');
    const [lastCoreIdeaKey, setLastCoreIdeaKey] = useState('');
    // Question index currently being swapped via the regenerate endpoint
    // — used for the spinner state on the Swap button.
    const [swappingIdx, setSwappingIdx] = useState(null);
    // answers[idx] is a string for text/examples_text/choice questions OR
    // an array of option strings for multi questions.
    const [answers, setAnswers] = useState(_hydrateQA.answers);
    // Questions the user has intentionally chosen to skip. Continue is
    // gated on every question being either answered OR explicitly
    // skipped, so users move forward without being forced to answer
    // each one.
    const [skippedQuestions, setSkippedQuestions] = useState(new Set());

    // Step 3 state
    const [coreIdea, setCoreIdea] = useState(initialSession?.core_idea || '');
    const [coreIdeaLoading, setCoreIdeaLoading] = useState(false);

    // Story-timeline step — students list the events they want to mention,
    // each with an optional time marker. The order they end up in here is
    // the order the council should respect in the essay (paired with the
    // CHRONOLOGY_BLOCK directive on the backend). Empty list = the user
    // doesn't have one; the timeline block is omitted from the brief.
    const [timelineEvents, setTimelineEvents] = useState(_hydrateQA.timeline || []);
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

    // Per-question follow-up state ("interview me" loop). Keyed by the
    // INDEX of the original question.
    //   followUps[i] = {
    //     loading?: bool, error?: string,
    //     question?: string, anchor?: string, subtext?: string,
    //     questionId?: string,            // server-issued
    //     answer?: string,                // user's reply
    //     declined?: bool,                // server returned no question (answer was already specific)
    //   }
    const [followUps, setFollowUps] = useState({});
    // Cap follow-ups per session so we don't pester the student.
    const MAX_FOLLOW_UPS_PER_SESSION = 2;
    const followUpsAskedCount = useMemo(
        () =>
            Object.values(followUps).filter(
                (f) => f && f.question && !f.declined
            ).length,
        [followUps]
    );

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

    const handleRequestFollowUp = async (i) => {
        const q = questions[i];
        if (!q || q.kind !== 'text') return;
        const answer = (answers[i] || '').trim();
        if (answer.length < 20) return;
        if (followUpsAskedCount >= MAX_FOLLOW_UPS_PER_SESSION) return;
        setFollowUps((prev) => ({
            ...prev,
            [i]: { ...(prev[i] || {}), loading: true, error: null },
        }));
        try {
            const res = await api.intake.followUp({
                topic: topic.trim(),
                audience: audience.trim(),
                question: q.question,
                answer,
                alreadyAsked: questions
                    .filter((qq) => qq?.question)
                    .map((qq) => qq.question),
            });
            const fu = res?.question;
            if (!fu || !fu.question) {
                setFollowUps((prev) => ({
                    ...prev,
                    [i]: { loading: false, declined: true },
                }));
                return;
            }
            setFollowUps((prev) => ({
                ...prev,
                [i]: {
                    loading: false,
                    questionId: fu.question_id,
                    question: fu.question,
                    anchor: fu.anchor || '',
                    subtext: fu.subtext || '',
                    answer: '',
                    declined: false,
                },
            }));
        } catch (err) {
            setFollowUps((prev) => ({
                ...prev,
                [i]: {
                    loading: false,
                    error: err?.message || 'Could not load follow-up',
                },
            }));
        }
    };

    const handleFollowUpAnswerChange = (i, value) => {
        setFollowUps((prev) => ({
            ...prev,
            [i]: { ...(prev[i] || {}), answer: value },
        }));
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

    // Autosave the current step to the session row whenever it changes.
    // Cheap (one PATCH per transition) and load-bearing for the sidebar
    // resume feature — without it we'd have no way to know where the
    // user was when they closed the tab. Skips while there's no session
    // yet (we're still on Step 1 before the row was created).
    useEffect(() => {
        if (!session?.id) return;
        // Don't autosave on the same step the row was loaded with — the
        // initialSession already has it.
        if (initialSession && initialSession.step === step) return;
        api.sessions
            .update(session.id, { step })
            .then(() => {
                // Tell App that the sidebar should refresh so the step
                // label + relative time stay in sync.
                onSessionChanged?.();
            })
            .catch((err) => console.warn('autosave step failed:', err));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, session?.id]);

    // Recovery: if we landed on step 2 (resume or navigation) but have
    // no questions — either because the old autosave only persisted
    // answered questions, or the session was created before questions
    // streamed — regenerate them automatically.
    useEffect(() => {
        if (step !== 'questions') return;
        if (questions.length > 0) return;
        if (questionsLoading || questionsStreaming) return;
        const trimmedTopic = topic.trim();
        if (!trimmedTopic) return;
        startQuestionStream({
            trimmedTopic,
            trimmedAudience: audience.trim(),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    // Debounced autosave for the typed-in fields. Audience, core idea,
    // and the Q&A list all get written ~1.5s after the user stops
    // editing, so reload-mid-flow restores cleanly. We persist the FULL
    // TypedQuestion object so resume can render multi-select / chips
    // correctly, not just the text.
    useEffect(() => {
        if (!session?.id) return;
        const handle = setTimeout(() => {
            const patch = {};
            const trimmedAudience = audience.trim();
            const trimmedCoreIdea = coreIdea.trim();
            const trimmedTopic = topic.trim();
            if (trimmedTopic && trimmedTopic !== (session.topic || '').trim()) {
                patch.topic = trimmedTopic;
            }
            if (trimmedAudience !== (session.audience || '').trim()) {
                patch.audience = trimmedAudience || null;
            }
            if (trimmedCoreIdea !== (session.core_idea || '').trim()) {
                patch.core_idea = trimmedCoreIdea;
            }
            // Build the conversation block: full question objects so
            // resume can rebuild the typed UI. Persist ALL questions
            // (not just answered ones) so resuming at step 2 shows
            // the full question set even if the user hasn't answered yet.
            const qa = questions
                .map((q, i) => ({
                    question: q,
                    answer: serializeAnswer(q, answers[i]) || '',
                }));
            const withTimeline = timelineEvents.length
                ? [...qa, { kind: 'timeline', events: timelineEvents }]
                : qa;
            const persistedConv = JSON.stringify(session.conversation || []);
            const incomingConv = JSON.stringify(withTimeline);
            if (incomingConv !== persistedConv) {
                patch.conversation = withTimeline;
            }
            if (Object.keys(patch).length === 0) return;
            api.sessions
                .update(session.id, patch)
                .then((row) => {
                    // Refresh the in-memory session snapshot so the next
                    // diff is against the latest persisted state.
                    if (row) setSession(row);
                    onSessionChanged?.();
                })
                .catch((err) => console.warn('autosave content failed:', err));
        }, 1500);
        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topic, audience, coreIdea, questions, answers, timelineEvents, session?.id]);

    // -----------------------------------------------------------------------
    // Step 1 — Topic + Audience
    // -----------------------------------------------------------------------
    // Helpers for the "forward never destroys work" rule. We snapshot the
    // inputs whenever we run the heavy LLM step, then on later forward
    // navigations we compare current vs snapshot to know whether the user
    // would want to regenerate. The actual decision is theirs — they
    // press the ↻ button if they want fresh content.
    const currentQuestionsKey = () =>
        JSON.stringify({
            topic: topic.trim().toLowerCase(),
            audience: audience.trim().toLowerCase(),
        });

    const FALLBACK_SECTIONS = [
        { id: 'positioning', label: 'How you want admissions to see you' },
        { id: 'story', label: 'A real moment, place, or thing' },
        { id: 'tactics', label: 'Wrap-up' },
    ];
    const FALLBACK_QUESTIONS = [
        {
            question_id: 'fallback-1',
            kind: 'text',
            section: 'positioning',
            question: 'If admissions had to remember three things about you, what would they be?',
            subtext: "Not adjectives off a list — words that point at something you've actually done.",
        },
        {
            question_id: 'fallback-2',
            kind: 'text',
            section: 'story',
            question: "What's a moment from this year you keep replaying in your head?",
            subtext: 'Where were you, who else was there, what made it stick?',
        },
        {
            question_id: 'fallback-3',
            kind: 'text',
            section: 'story',
            question: "What's something in your room right now that would be hard to throw away?",
            subtext: "An object that has a story most people don't know.",
        },
        {
            question_id: 'fallback-4',
            kind: 'text',
            section: 'tactics',
            question: "After admissions reads this essay, what's one thing you'd NOT want them to assume about you?",
            subtext: "Pin it to what you've already shared above — what could be misread, and how would you want it read instead?",
        },
    ];

    // Kick off (or restart) the question stream. Used both on first
    // Step 1 → Step 2 transition AND by the ↻ Regenerate button on
    // Step 2. Resets the question list before streaming so old answers
    // attached to old questions don't bleed into the new set.
    const startQuestionStream = ({ trimmedTopic, trimmedAudience }) => {
        setQuestionsLoading(true);
        setQuestionsStreaming(true);
        setQuestions([]);
        setSections([]);
        setAnswers({});
        setSkippedQuestions(new Set());
        setExamples({});
        setFollowUps({});
        setLastQuestionsKey(
            JSON.stringify({
                topic: trimmedTopic.toLowerCase(),
                audience: trimmedAudience.toLowerCase(),
            })
        );
        const { promise } = api.intake.streamQuestions({
            topic: trimmedTopic,
            audience: trimmedAudience,
            onSections: (incomingSections) => {
                setSections(incomingSections);
            },
            onQuestion: (question) => {
                setQuestions((prev) => [...prev, question]);
                setQuestionsLoading(false);
            },
            onError: (msg) => {
                console.warn('intake stream error:', msg);
            },
        });
        promise
            .catch((err) => {
                console.warn('intake/questions stream failed:', err);
            })
            .finally(() => {
                setQuestionsLoading(false);
                setQuestionsStreaming(false);
                setSections((cur) => (cur.length ? cur : FALLBACK_SECTIONS));
                setQuestions((cur) => (cur.length ? cur : FALLBACK_QUESTIONS));
            });
    };

    const handleRegenerateQuestions = () => {
        if (questionsStreaming) return;
        startQuestionStream({
            trimmedTopic: topic.trim(),
            trimmedAudience: audience.trim(),
        });
    };

    const handleSubmitTopic = async (e) => {
        e?.preventDefault?.();
        setError(null);
        const trimmedTopic = topic.trim();
        if (!trimmedTopic) {
            setError('Tell me what your essay is about.');
            return;
        }
        if (!audience.trim()) {
            setError("Pick what kind of essay this is — the council needs to know who it's writing for.");
            return;
        }
        setSubmitting(true);
        try {
            // Re-use the existing session row if one already exists for
            // this flow — going Back → forward shouldn't spawn a fresh
            // essay_sessions row each time.
            let s = session;
            if (!s) {
                s = await api.sessions.create(trimmedTopic);
                setSession(s);
                // New draft just landed — notify App so the sidebar
                // surfaces it immediately.
                onSessionChanged?.();
                // Memory-check is non-blocking. Failures are silent.
                api.sessions
                    .memoryCheck(trimmedTopic)
                    .then((res) => {
                        if (res?.found && Array.isArray(res.matches)) {
                            setMemoryMatches(res.matches);
                        }
                    })
                    .catch(() => {});
            }

            setStep('questions');
            // "Forward never destroys work": only stream if we don't
            // already have questions. The ↻ button on Step 2 lets users
            // explicitly request a fresh set when their topic/audience
            // changed in a way that warrants it.
            if (questions.length === 0) {
                startQuestionStream({
                    trimmedTopic,
                    trimmedAudience: audience.trim(),
                });
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

    const buildAnsweredQa = () => {
        const out = [];
        questions.forEach((q, i) => {
            const baseQuestion = q?.question || '';
            const baseAnswer = serializeAnswer(q, answers[i]);
            if (baseQuestion && baseAnswer) {
                out.push({ question: baseQuestion, answer: baseAnswer });
            }
            // Inline follow-up Q&A right after the parent so the brief
            // reads as a real conversation, not a flat list.
            const fu = followUps[i];
            if (fu && fu.question && (fu.answer || '').trim()) {
                out.push({
                    question: `Follow-up: ${fu.question}`,
                    answer: fu.answer.trim(),
                });
            }
        });
        return out;
    };

    const handleSubmitAnswers = async () => {
        setError(null);
        const answeredCount = buildAnsweredQa().length;
        if (answeredCount < 1) {
            setError("Answer at least one question — even one short reply gives the council something concrete to work with.");
            return;
        }
        await advanceToCoreIdea();
    };

    // Stable signature of the current Q&A used to decide whether the
    // core idea is "still in sync." Normalises by lowercasing answers
    // and trimming whitespace so cosmetic edits don't trigger the
    // "inputs changed" indicator on the ↻ button.
    const currentCoreIdeaKey = () => {
        const qa = buildAnsweredQa();
        return JSON.stringify(
            qa.map(({ question, answer }) => ({
                q: (question || '').trim(),
                a: (answer || '').trim().toLowerCase(),
            }))
        );
    };

    const generateCoreIdea = async () => {
        setCoreIdeaLoading(true);
        try {
            const qa = buildAnsweredQa();
            const newKey = currentCoreIdeaKey();
            const res = await api.intake.coreIdea({
                topic: topic.trim(),
                audience: audience.trim(),
                qa,
                sessionId: session.id,
            });
            setCoreIdea(res?.core_idea || '');
            setLastCoreIdeaKey(newKey);
        } catch (err) {
            console.warn('intake/core-idea failed:', err);
            setCoreIdea('');
        } finally {
            setCoreIdeaLoading(false);
        }
    };

    const handleRegenerateCoreIdea = async () => {
        if (coreIdeaLoading) return;
        await generateCoreIdea();
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
            // "Forward never destroys work": only generate if there's
            // nothing to preserve. The ↻ button on Step 3 lets users
            // explicitly rebuild from their (possibly edited) answers.
            if (!coreIdea.trim()) {
                await generateCoreIdea();
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
    //
    // `answers[i]` is a string for text/examples_text/choice questions
    // but an Array for multi-select. Using `serializeAnswer` unifies
    // both into a string so the persistence payload is always JSON-safe
    // — calling .trim() on an array (the old path) throws and broke
    // Step 4 Continue when any multi-select question was answered.
    const persistTimelineToSession = async (events) => {
        if (!session?.id) return;
        const qa = questions
            .map((q, i) => ({ question: q, answer: serializeAnswer(q, answers[i]) }))
            .filter((item) => (item.answer || '').trim());
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
        try {
            await persistTimelineToSession(timelineEvents);
        } catch (e) {
            // Belt-and-suspenders: persistTimelineToSession already
            // swallows its own errors, but if something else throws
            // (serialization, transient state) we still want Continue
            // to navigate. The timeline lives in state and will be
            // sent to the council either way.
            console.warn('Timeline persist threw, navigating anyway:', e);
        }
        setStep('voice');
    };

    const handleSkipTimeline = async () => {
        setError(null);
        setTimelineEvents([]);
        try {
            await persistTimelineToSession([]);
        } catch (e) {
            console.warn('Timeline persist threw, navigating anyway:', e);
        }
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

    const STEP_ORDER = ['topic', 'questions', 'core_idea', 'timeline', 'voice'];
    const STEP_LABELS = {
        topic: 'Topic & audience',
        questions: 'A few questions',
        core_idea: 'Your core idea',
        timeline: 'Story timeline',
        voice: 'Voice & ready',
    };
    const STEP_PREV = {
        questions: 'topic',
        core_idea: 'questions',
        timeline: 'core_idea',
        voice: 'timeline',
        draft: 'topic',
    };
    const stepIndex = STEP_ORDER.indexOf(step);
    const showStepper = stepIndex >= 0;
    const prevStep = STEP_PREV[step] || null;
    const [questionsFullscreen, setQuestionsFullscreen] = useState(false);

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
                {/* Consistent top bar across all 5 main steps. Same skeleton
                    every time — back button on the left, topic chip in the
                    middle (when populated), 5-dot progress on the right —
                    so the user's eye doesn't have to relearn the layout.
                    Below it, a small-caps step badge identifies WHERE the
                    user is in the flow. On Step 1 the back button + chip
                    are absent (no previous step, nothing typed yet); the
                    skeleton still occupies the row so the badge + h1 sit
                    in the same place as on every other step. */}
                {showStepper && (
                    <>
                        <div className="essay-flow-top-bar">
                            {prevStep ? (
                                <button
                                    type="button"
                                    className="essay-flow-back-btn"
                                    onClick={() => setStep(prevStep)}
                                    disabled={disabled}
                                    title={`Back to ${STEP_LABELS[prevStep] || 'previous step'}`}
                                    aria-label={`Back to ${STEP_LABELS[prevStep] || 'previous step'}`}
                                >
                                    ←
                                </button>
                            ) : (
                                <div className="essay-flow-back-btn-spacer" aria-hidden="true" />
                            )}

                            <div className="essay-flow-top-bar-center">
                                {showTopicChip && (topic || audience) && (
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
                            </div>

                            <div className="essay-flow-stepper-dots" aria-label="Intake progress">
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

                        <div className="essay-flow-step-badge">
                            Step {stepIndex + 1} of {STEP_ORDER.length} · {STEP_LABELS[step]}
                        </div>
                    </>
                )}

                {step === 'topic' && (
                    <form onSubmit={handleSubmitTopic} className="essay-flow-step essay-flow-step--topic">
                        <h1 className="essay-flow-question">What are you writing?</h1>

                        <textarea
                            id="essay-flow-topic"
                            ref={topicRef}
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            placeholder={'Paste the prompt, or describe your essay.\n\ne.g. "Discuss an accomplishment, event, or realization that sparked a period of personal growth…"\n\nor: The summer my grandmother stopped recognizing my name.'}
                            disabled={disabled}
                            className="essay-flow-textarea essay-flow-textarea--topic"
                            rows={6}
                            maxLength={2000}
                        />
                        <div className="essay-flow-topic-hint">
                            Long is fine — paste the whole prompt.
                        </div>

                        <div className="essay-flow-topic-secondary">
                            <button
                                type="button"
                                className="essay-flow-link essay-flow-link--soft"
                                onClick={handleStartBrainstorm}
                                disabled={disabled}
                            >
                                No topic yet?
                            </button>
                            <span className="essay-flow-topic-secondary-sep" aria-hidden="true">·</span>
                            <button
                                type="button"
                                className="essay-flow-link essay-flow-link--soft"
                                onClick={handleJumpToDraft}
                                disabled={disabled || !topic.trim()}
                            >
                                Already wrote a draft?
                            </button>
                        </div>

                        <div className="essay-flow-topic-kind">
                            <div className="essay-flow-topic-kind-label">
                                What kind?
                                <span className="essay-flow-topic-kind-required" aria-hidden="true"> *</span>
                            </div>
                            <div className="essay-flow-topic-kind-why">
                                This changes everything the council writes — a Common App essay reads very differently from a "why this school" supplemental.
                            </div>
                            <div
                                className="essay-flow-audience-chips"
                                role="group"
                                aria-label="Essay type"
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
                                placeholder="Or type your own — e.g. Stanford REA short answer"
                                disabled={disabled}
                                className="essay-flow-input essay-flow-input--inline"
                                maxLength={250}
                            />
                        </div>

                        {error && <div className="essay-flow-error">{error}</div>}
                        <div className="essay-flow-actions essay-flow-actions--single">
                            <button
                                type="submit"
                                className="essay-flow-primary"
                                disabled={disabled || !topic.trim() || !audience.trim()}
                                title={
                                    !topic.trim()
                                        ? 'Tell me what the essay is about first.'
                                        : !audience.trim()
                                            ? 'Pick what kind of essay this is — the council needs to know who it\'s writing for.'
                                            : 'Continue to the next step'
                                }
                            >
                                {submitting ? 'Starting…' : 'Continue →'}
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
                    <div className={`essay-flow-step ${questionsFullscreen ? 'essay-flow-step--fullscreen' : ''}`}>
                        <button
                            type="button"
                            className="essay-flow-fullscreen-btn"
                            onClick={() => setQuestionsFullscreen(v => !v)}
                            title={questionsFullscreen ? 'Exit full screen' : 'Expand for more room'}
                            aria-label={questionsFullscreen ? 'Exit full screen' : 'Full screen'}
                        >
                            {questionsFullscreen ? (
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="6 1 1 1 1 6" /><polyline points="10 15 15 15 15 10" />
                                    <line x1="1" y1="1" x2="6" y2="6" /><line x1="15" y1="15" x2="10" y2="10" />
                                </svg>
                            ) : (
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="10 1 15 1 15 6" /><polyline points="6 15 1 15 1 10" />
                                    <line x1="15" y1="1" x2="10" y2="6" /><line x1="1" y1="15" x2="6" y2="10" />
                                </svg>
                            )}
                        </button>
                        <div className="essay-flow-question-row">
                            <h2 className="essay-flow-question">A few questions to make this sound like you</h2>
                            {questions.length > 0 && (
                                <button
                                    type="button"
                                    className={
                                        'essay-flow-regenerate ' +
                                        (currentQuestionsKey() !== lastQuestionsKey
                                            ? 'essay-flow-regenerate--dirty'
                                            : '')
                                    }
                                    onClick={handleRegenerateQuestions}
                                    disabled={disabled || questionsStreaming}
                                    title={
                                        currentQuestionsKey() !== lastQuestionsKey
                                            ? 'Your topic or audience changed — get a fresh question set tailored to the new input'
                                            : 'Replace these with a fresh question set (your current answers will be cleared)'
                                    }
                                >
                                    ↻ {questionsStreaming ? 'Generating…' : 'Get fresh questions'}
                                </button>
                            )}
                        </div>
                        <p className="essay-flow-hint">
                            Talk as much as you want — the more detail you give, the better the council understands you. Think out loud, ramble, contradict yourself. We'll sort it out.
                        </p>
                        <div
                            className="essay-flow-toolbar-legend"
                            aria-label="What each per-question button does"
                        >
                            <span className="essay-flow-toolbar-legend-intro">
                                Each question has three buttons:
                            </span>
                            <span className="essay-flow-toolbar-legend-item">
                                <span
                                    className="mic-button mic-button--sm"
                                    role="presentation"
                                    aria-hidden="true"
                                    onClick={(e) => e.preventDefault()}
                                >
                                    <span className="mic-button-icon" aria-hidden="true">🎤</span>
                                </span>
                                <span>talk instead of type</span>
                            </span>
                            <span className="essay-flow-toolbar-legend-item">
                                <span
                                    className="essay-flow-skip-question"
                                    role="presentation"
                                    aria-hidden="true"
                                    onClick={(e) => e.preventDefault()}
                                >
                                    Different question
                                </span>
                                <span>this one doesn't fit</span>
                            </span>
                            <span className="essay-flow-toolbar-legend-item">
                                <span
                                    className="essay-flow-skip-question"
                                    role="presentation"
                                    aria-hidden="true"
                                    onClick={(e) => e.preventDefault()}
                                >
                                    Skip
                                </span>
                                <span>nothing to say</span>
                            </span>
                        </div>
                        {questionsLoading && questions.length === 0 && (
                            <div className="essay-flow-hint" style={{ opacity: 0.8 }}>
                                Drafting questions for your topic… first one arrives in a second or two.
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
                                                        title="Give me a different question — this one doesn't fit"
                                                    >
                                                        {isSwappingThis ? 'Swapping…' : 'Different question'}
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
                                                    "Say as much as you want. Specifics, stories, contradictions, half-thoughts — all useful. Tap the mic to talk it through instead of typing."
                                                }
                                                rows={6}
                                                disabled={disabled || isSwappingThis}
                                                className="essay-flow-textarea"
                                                style={{ minHeight: 160 }}
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

                                        {(() => {
                                            // Interview-mode follow-up. Shown only on text
                                            // questions with a substantive answer. Capped at
                                            // MAX_FOLLOW_UPS_PER_SESSION across the whole
                                            // intake so we don't pester the student.
                                            if (isSkipped) return null;
                                            if (kind !== 'text') return null;
                                            const answerLen = (textValue || '').trim().length;
                                            const fu = followUps[i];
                                            const showButton =
                                                answerLen >= 20 &&
                                                !fu?.question &&
                                                !fu?.loading &&
                                                !fu?.declined &&
                                                followUpsAskedCount < MAX_FOLLOW_UPS_PER_SESSION;
                                            return (
                                                <>
                                                    {showButton && (
                                                        <div className="essay-flow-example-row">
                                                            <button
                                                                type="button"
                                                                className="essay-flow-example-toggle"
                                                                onClick={() => handleRequestFollowUp(i)}
                                                                disabled={disabled || isSwappingThis}
                                                                title="Ask the coach to dig deeper on your answer"
                                                            >
                                                                Coach me — go one level deeper
                                                            </button>
                                                        </div>
                                                    )}
                                                    {fu?.loading && (
                                                        <div className="essay-flow-hint" style={{ opacity: 0.75, marginTop: '0.5rem' }}>
                                                            Listening to what you wrote…
                                                        </div>
                                                    )}
                                                    {fu?.error && (
                                                        <div className="essay-flow-example-error">
                                                            {fu.error}
                                                        </div>
                                                    )}
                                                    {fu?.declined && (
                                                        <div className="essay-flow-hint" style={{ opacity: 0.7, marginTop: '0.5rem' }}>
                                                            Your answer is already specific enough — no follow-up needed.
                                                        </div>
                                                    )}
                                                    {fu?.question && (
                                                        <div className="essay-flow-example" style={{ borderLeftColor: '#fbbf24' }}>
                                                            <div className="essay-flow-example-label">
                                                                Coach follow-up
                                                            </div>
                                                            {fu.anchor && (
                                                                <div
                                                                    className="essay-flow-exchange-subtext"
                                                                    style={{ fontStyle: 'italic', marginTop: '0.25rem' }}
                                                                >
                                                                    Pinned to: "{fu.anchor}"
                                                                </div>
                                                            )}
                                                            <div
                                                                className="essay-flow-exchange-q"
                                                                style={{ marginTop: '0.5rem' }}
                                                            >
                                                                {fu.question}
                                                            </div>
                                                            {fu.subtext && (
                                                                <div className="essay-flow-exchange-subtext">
                                                                    {fu.subtext}
                                                                </div>
                                                            )}
                                                            <textarea
                                                                value={fu.answer || ''}
                                                                onChange={(e) => handleFollowUpAnswerChange(i, e.target.value)}
                                                                placeholder="Answer in as much detail as you want — this is optional, but it sharpens the essay a lot."
                                                                rows={4}
                                                                disabled={disabled}
                                                                className="essay-flow-textarea"
                                                                style={{ minHeight: 110, marginTop: '0.5rem' }}
                                                            />
                                                        </div>
                                                    )}
                                                </>
                                            );
                                        })()}
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

                        {questionsStreaming && questions.length > 0 && (
                            <div
                                className="essay-flow-question-skeleton"
                                aria-label="More questions on the way"
                                role="status"
                            >
                                <div className="essay-flow-question-skeleton-line essay-flow-question-skeleton-line--long" />
                                <div className="essay-flow-question-skeleton-line essay-flow-question-skeleton-line--medium" />
                                <div className="essay-flow-question-skeleton-textarea" />
                            </div>
                        )}

                        {error && <div className="essay-flow-error">{error}</div>}

                        <div className="essay-flow-actions">
                            <button
                                type="button"
                                className="essay-flow-primary"
                                onClick={handleSubmitAnswers}
                                disabled={
                                    disabled ||
                                    questionsLoading ||
                                    questionsStreaming ||
                                    !allQuestionsHandled
                                }
                                title={
                                    questionsStreaming
                                        ? 'Waiting for the remaining questions to arrive…'
                                        : allQuestionsHandled
                                            ? 'Continue to your core idea'
                                            : 'Answer or skip each question to continue'
                                }
                            >
                                {submitting
                                    ? 'Saving…'
                                    : questionsStreaming
                                        ? 'Loading more…'
                                        : 'Continue'}
                            </button>
                        </div>
                    </div>
                )}

                {step === 'core_idea' && (
                    <div className="essay-flow-step">
                        <div className="essay-flow-question-row">
                            <h2 className="essay-flow-question">The shape of it</h2>
                            {coreIdea.trim() && (
                                <button
                                    type="button"
                                    className={
                                        'essay-flow-regenerate ' +
                                        (currentCoreIdeaKey() !== lastCoreIdeaKey
                                            ? 'essay-flow-regenerate--dirty'
                                            : '')
                                    }
                                    onClick={handleRegenerateCoreIdea}
                                    disabled={disabled || coreIdeaLoading}
                                    title={
                                        currentCoreIdeaKey() !== lastCoreIdeaKey
                                            ? 'Your answers changed — rebuild the core idea from the new answers'
                                            : 'Rebuild the core idea from your answers (replaces your edits)'
                                    }
                                >
                                    ↻ {coreIdeaLoading ? 'Rebuilding…' : 'Rebuild from answers'}
                                </button>
                            )}
                        </div>
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
                        <h2 className="essay-flow-question">Story timeline (optional)</h2>

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
