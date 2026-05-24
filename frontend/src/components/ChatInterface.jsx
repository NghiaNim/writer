import StageTimer from './StageTimer';
import { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import SearchContext from './SearchContext';
import Stage1 from './Stage1';
import Stage2 from './Stage2';
import { PitchSummary, SpinePick } from './CouncilDecisions';
import CouncilGrid from './CouncilGrid';
import CouncilChips from './CouncilChips';
import EssayLoadingStatus from './EssayLoadingStatus';
import BrewingConsole from './BrewingConsole';
import BrewBar from './BrewBar';
import UserBriefMessage from './UserBriefMessage';
import InterimQuestions from './InterimQuestions';
import FinalEssay from './FinalEssay';
import { api } from '../api';
import MicButton from './common/MicButton';
import { useTunable } from '../tunables';
import './ChatInterface.css';

const PERSONA_NAME_BY_KEY = {
    architect: 'The Architect',
    editor: 'The Editor',
    devils_advocate: "The Devil's Advocate",
    voice_guardian: 'The Voice Guardian',
};

// Build the chip data for CouncilChips out of (a) the user's chosen council
// config (provides persona names + models in execution order) and (b) the
// in-flight assistant message's loading + progress flags. Returns null if we
// don't have enough info to render anything useful.
function buildChipState(activeCouncil, msg) {
    if (!activeCouncil || !activeCouncil.personas) return null;
    const enabled = activeCouncil.personas.filter((p) => p.enabled);
    if (!enabled.length) return null;

    const personas = enabled.map((p) => ({
        key: p.key,
        name: PERSONA_NAME_BY_KEY[p.key] || p.key,
        model: p.model,
    }));
    const chairman = activeCouncil.chairman_model
        ? { name: 'Chairman', model: activeCouncil.chairman_model }
        : null;

    // Between SSE phases (e.g., the chairman-clarification wait between
    // stage2_complete and stage3_start) all loading.* flags briefly go
    // false simultaneously. The promote-after-completion fallbacks below
    // keep chips moving forward instead of regressing to "queued" — each
    // promote is gated on the previous stage's loading flag being OFF so
    // we don't jump ahead during incremental streaming.
    let stage = 'idle';
    if (msg?.loading?.search) stage = 'search';
    if (msg?.pitches?.length && !msg?.loading?.search) stage = 'stage1';
    if (msg?.loading?.stage1) stage = 'stage1';
    if (msg?.stage1 && !msg?.loading?.stage1) stage = 'stage2';
    if (msg?.loading?.stage2) stage = 'stage2';
    if (msg?.stage2 && !msg?.loading?.stage2) stage = 'stage3';
    if (msg?.loading?.stage3) stage = 'stage3';
    if (msg?.stage3) stage = 'done';

    const stage1Done = Math.min(
        personas.length,
        msg?.progress?.stage1?.count || 0
    );
    return { personas, chairman, stage, stage1Done };
}

function stage3EssayText(msg) {
    if (!msg?.stage3) return '';
    const r = msg.stage3.response;
    return typeof r === 'string' ? r : String(r || '');
}

function getLatestCompletedEssayText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && stage3EssayText(m).trim()) {
            return stage3EssayText(m);
        }
    }
    return '';
}

function getOriginalEssayBrief(messages) {
    const first = messages.find((m) => m.role === 'user');
    return typeof first?.content === 'string' ? first.content : '';
}

/** Bundles the latest essay + original brief so the council can refine without server-side history. */
function buildRefinementPayload(messages, instruction) {
    const latest = getLatestCompletedEssayText(messages);
    const brief = getOriginalEssayBrief(messages);
    const trimmed = (instruction || '').trim();
    return [
        '## Refinement instruction',
        'Apply the following to the essay under "Current essay". Keep voice and structure unless asked otherwise.',
        trimmed,
        '',
        '## Current essay (revise this)',
        latest,
        '',
        '## Original intake (context only)',
        brief,
    ].join('\n');
}

const REFINEMENT_SUGGESTIONS = [
    {
        label: 'Sharpen the hook',
        instruction:
            'Rewrite the opening so the hook is sharper and more specific; align the rest of the essay with the new opening.',
    },
    {
        label: 'Tighten length',
        instruction:
            'Cut roughly 15–20% of the length without losing the main argument. Remove repetition and tighten sentences.',
    },
    {
        label: 'More concrete detail',
        instruction:
            'Add concrete, sensory, or specific examples where the essay is overly abstract. No generic filler.',
    },
    {
        label: 'Warmer, personal tone',
        instruction:
            'Shift tone slightly toward a warmer, more personal voice while keeping the argument clear and honest.',
    },
    {
        label: 'Stronger ending',
        instruction:
            'Rewrite the closing paragraph so it lands with more force and clearer stakes. Do not introduce unrelated new topics.',
    },
    {
        label: 'Stress-test claims',
        instruction:
            'Find vague or overstated claims, qualify or strengthen them, and briefly acknowledge one plausible counterargument.',
    },
];

export default function ChatInterface({
    conversation,
    conversationId = null,
    sessionId = null,
    onSendMessage,
    onAbort,
    onRegenerate,
    onAnswerInterim,
    isLoading,
    councilConfigured,
    onOpenSettings,
    councilModels = [],
    chairmanModel = null,
    essayMode = 'topic',
    onEssayModeChange,
    searchProvider = 'duckduckgo',
    activeCouncil = null,
    activeWordTarget = null,
}) {
    const brewingConsoleV2 = useTunable('brewingConsoleV2');
    const [input, setInput] = useState('');
    const [webSearch, setWebSearch] = useState(false);
    const [composerCollapsed, setComposerCollapsed] = useState(false);
    const [essayFeedbackDoneKey, setEssayFeedbackDoneKey] = useState(null);
    const [feedbackRating, setFeedbackRating] = useState(null);
    const [feedbackHoverRating, setFeedbackHoverRating] = useState(null);
    const [feedbackNotes, setFeedbackNotes] = useState('');
    const [feedbackSaving, setFeedbackSaving] = useState(false);
    const [feedbackError, setFeedbackError] = useState(null);
    const [saveFactFromFeedback, setSaveFactFromFeedback] = useState(false);
    const messagesEndRef = useRef(null);
    const messagesContainerRef = useRef(null);
    const conversationRef = useRef(conversation);
    const [focusedDraftSlot, setFocusedDraftSlot] = useState(0);
    const [refinementDockCollapsed, setRefinementDockCollapsed] = useState(false);
    const [dynamicSuggestions, setDynamicSuggestions] = useState([]);
    const [suggestionsLoading, setSuggestionsLoading] = useState(false);

    // Fact-check "Fix this" flow. We track per-conversation:
    //   fixingFlagIdx          — index of the flag currently being fixed
    //   factCheckDismissedSet  — set of flag indexes the user has either
    //                            dismissed manually or that auto-dismissed
    //                            after a successful Fix landing.
    // Both reset on conversationId change (see the existing cleanup effect).
    const [fixingFlagIdx, setFixingFlagIdx] = useState(null);
    const [factCheckDismissedSet, setFactCheckDismissedSet] = useState(new Set());

    // Rule-proposal flow: when the user TYPES a custom refinement (not a chip)
    // and the resulting essay finishes, ask if they want to save the
    // instruction as a durable rule for future essays. Chip clicks are
    // skipped — they're already-canned and not the user's own wording.
    const [pendingRuleText, setPendingRuleText] = useState(null);
    const [pendingRuleAtCount, setPendingRuleAtCount] = useState(0);
    const [ruleProposalState, setRuleProposalState] = useState('idle');
    // 'idle' | 'asking' | 'saving' | 'saved' | 'dismissed' | 'error'
    const [ruleProposalRule, setRuleProposalRule] = useState(null);
    const [ruleProposalError, setRuleProposalError] = useState(null);
    const prevLoadingRef = useRef(isLoading);

    const draftMessageIndices = useMemo(() => {
        const list = conversation?.messages || [];
        return list
            .map((m, i) =>
                m.role === 'assistant' && stage3EssayText(m).trim() ? i : null
            )
            .filter((i) => i != null);
    }, [conversation]);

    const draftNavKey = draftMessageIndices.join(',');

    // The most recent in-flight assistant message — feeds the bottom BrewBar
    // its live stage / progress / cycling-message context. The BrewBar
    // independently subscribes to the same `loading` shape that BrewingConsole
    // uses up-stream, so the two surfaces stay in lockstep without us having
    // to plumb cycle indices around.
    const inflightMsg = useMemo(() => {
        if (!isLoading || !conversation?.messages?.length) return null;
        const last = conversation.messages[conversation.messages.length - 1];
        return last?.role === 'assistant' ? last : null;
    }, [conversation, isLoading]);

    const showRefinementDock =
        Boolean(conversation) &&
        draftMessageIndices.length > 0 &&
        councilConfigured;

    const essayFeedbackKey = useMemo(() => {
        if (!conversationId || !conversation?.messages?.length) return null;
        const m = conversation.messages;
        const li = m.length - 1;
        const lm = m[li];
        if (lm?.role !== 'assistant' || !lm?.stage3 || isLoading) {
            return null;
        }
        return `${conversationId}-${li}`;
    }, [conversation, conversationId, isLoading]);

    const showEssayFeedbackBar =
        Boolean(essayFeedbackKey) && essayFeedbackDoneKey !== essayFeedbackKey;

    useEffect(() => {
        conversationRef.current = conversation;
    }, [conversation]);

    useEffect(() => {
        if (!isLoading) {
            setComposerCollapsed(false);
        }
    }, [isLoading]);

    useEffect(() => {
        setEssayFeedbackDoneKey(null);
        setFeedbackRating(null);
        setFeedbackNotes('');
        setFeedbackError(null);
        setSaveFactFromFeedback(false);
        setRefinementDockCollapsed(false);
        setDynamicSuggestions([]);
        setPendingRuleText(null);
        setPendingRuleAtCount(0);
        setRuleProposalState('idle');
        setRuleProposalRule(null);
        setRuleProposalError(null);
        setFixingFlagIdx(null);
        setFactCheckDismissedSet(new Set());
    }, [conversationId]);

    // When isLoading flips from true -> false AND a new draft has arrived
    // since we captured pendingRuleText, surface the rule-proposal prompt.
    useEffect(() => {
        const prev = prevLoadingRef.current;
        prevLoadingRef.current = isLoading;
        if (!prev || isLoading) return;
        if (!pendingRuleText) return;
        if (draftMessageIndices.length <= pendingRuleAtCount) return;
        setRuleProposalState('asking');
    }, [isLoading, draftMessageIndices.length, pendingRuleText, pendingRuleAtCount]);

    useEffect(() => {
        if (showEssayFeedbackBar && showRefinementDock) {
            setRefinementDockCollapsed(true);
        }
    }, [showEssayFeedbackBar, showRefinementDock]);

    useEffect(() => {
        if (!showRefinementDock || isLoading || !conversationId) {
            return undefined;
        }
        const conv = conversationRef.current;
        const essay = getLatestCompletedEssayText(conv?.messages || []);
        if (!essay.trim()) {
            return undefined;
        }
        const brief = getOriginalEssayBrief(conv?.messages || []);
        let cancelled = false;
        setSuggestionsLoading(true);
        api.refinement
            .suggestions({ essayText: essay, originalBrief: brief })
            .then((r) => {
                const list = r?.suggestions;
                if (
                    cancelled ||
                    !Array.isArray(list) ||
                    list.length < 3
                ) {
                    if (!cancelled) setDynamicSuggestions([]);
                    return;
                }
                const cleaned = list
                    .map((item) => ({
                        label: String(item?.label || '').trim(),
                        instruction: String(item?.instruction || '').trim(),
                    }))
                    .filter((x) => x.label && x.instruction);
                if (!cancelled) {
                    setDynamicSuggestions(cleaned.length >= 3 ? cleaned : []);
                }
            })
            .catch(() => {
                if (!cancelled) setDynamicSuggestions([]);
            })
            .finally(() => {
                if (!cancelled) setSuggestionsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [showRefinementDock, isLoading, conversationId, draftNavKey]);

    useEffect(() => {
        if (draftMessageIndices.length === 0) return;
        setFocusedDraftSlot(draftMessageIndices.length - 1);
    }, [conversationId, draftNavKey]);

    // Scroll to top when switching drafts — the focused draft is now the only
    // visible one so we want to read it from the beginning, not mid-page.
    useEffect(() => {
        if (!showRefinementDock || draftMessageIndices.length <= 1) return;
        if (messagesContainerRef.current) {
            messagesContainerRef.current.scrollTop = 0;
        }
    }, [focusedDraftSlot]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    // Only auto-scroll when message count changes (not on every streamed token)
    const messageCount = conversation?.messages?.length ?? 0;
    useEffect(() => {
        if (!messagesContainerRef.current) return;

        const container = messagesContainerRef.current;
        const isNearBottom =
            container.scrollHeight - container.scrollTop - container.clientHeight < 150;

        if (isNearBottom) {
            scrollToBottom();
        }
    }, [messageCount]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;
        const list = conversation?.messages || [];
        if (showRefinementDock) {
            if (!getLatestCompletedEssayText(list).trim()) return;
            // Capture the user's exact phrasing so we can offer to save it
            // as a rule once this refinement finishes streaming.
            setPendingRuleText(input.trim());
            setPendingRuleAtCount(draftMessageIndices.length);
            setRuleProposalState('idle');
            setRuleProposalRule(null);
            setRuleProposalError(null);
            onSendMessage(buildRefinementPayload(list, input.trim()), webSearch, {
                essayMode: 'draft',
                sessionId: sessionId || undefined,
            });
        } else {
            onSendMessage(input, webSearch);
        }
        setInput('');
    };

    // "Fix this" on a fact-check flag → pre-fill the refinement dock
    // with a structured instruction pinned to the flagged quote. The
    // user can tweak the wording and submit, or just hit Run as-is.
    // Once a new draft lands (isLoading flips true → false after this
    // click), we auto-dismiss the flag — see the effect below.
    const handleFixAll = (visibleFlags) => {
        if (!visibleFlags || !visibleFlags.length) return;
        const lines = visibleFlags.map((flag) => {
            const quote = (flag.quote || '').trim();
            const status = flag.status === 'contradicts' ? 'contradicts a known fact' : 'is unsupported';
            const note = (flag.note || '').trim();
            return `- "${quote}" — ${status}${note ? `. ${note}` : ''}`;
        });
        const prefill = [
            `Fix these ${visibleFlags.length} flagged claims:`,
            ...lines,
            '',
            'Replace each claim with something accurate, in the same voice. Keep the surrounding paragraphs intact except where needed for coherence.',
        ].join('\n');
        setInput(prefill);
        setFixingFlagIdx('all');
        setRefinementDockCollapsed(false);
        setTimeout(() => {
            const ta = document.querySelector('.refinement-prompt-input');
            if (ta && typeof ta.scrollIntoView === 'function') {
                ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
                ta.focus();
            }
        }, 50);
    };

    const handleDismissFlag = (idx) => {
        setFactCheckDismissedSet((prev) => {
            const next = new Set(prev);
            next.add(idx);
            return next;
        });
        // If they dismissed the flag they were actively fixing, clear that
        // state too so the spinner doesn't linger.
        if (fixingFlagIdx === idx) setFixingFlagIdx(null);
    };

    // When a refinement run completes after the user clicked Fix, drop
    // that flag from the visible list. We watch isLoading flipping
    // true→false; if a fix was in flight, the latest draft is the
    // attempted fix, so the flag has been "addressed" (a next
    // fact-check pass will re-flag if the rewrite didn't actually
    // resolve it). Dedicated ref so we don't race with the rule-
    // proposal effect's use of prevLoadingRef.
    const fixPrevLoadingRef = useRef(isLoading);
    useEffect(() => {
        const wasLoading = fixPrevLoadingRef.current;
        fixPrevLoadingRef.current = isLoading;
        if (wasLoading && !isLoading && fixingFlagIdx !== null) {
            setFactCheckDismissedSet((prev) => {
                const next = new Set(prev);
                next.add(fixingFlagIdx);
                return next;
            });
            setFixingFlagIdx(null);
        }
    }, [isLoading, fixingFlagIdx]);

    const handleKeyDown = (e) => {
        // Submit on Enter (without Shift)
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
        }
    };

    if (!conversation) {
        return (
            <div className="chat-interface">
                <div className="empty-state">
                    <h1>Welcome to MidnightCoffee</h1>
                    <p className="hero-message">
                        The Council is ready to deliberate. <button className="config-link" onClick={() => onOpenSettings('council')}>Configure it</button>
                    </p>

                    {/* Council Preview Grid */}
                    <div className="welcome-grid-container">
                        <CouncilGrid models={councilModels} chairman={chairmanModel} status="idle" />
                    </div>

                </div>
            </div>
        );
    }

    const msgs = conversation.messages || [];

    const sendRefinementSuggestion = (instruction) => {
        if (!instruction?.trim() || isLoading) return;
        if (!getLatestCompletedEssayText(msgs).trim()) return;
        // Chip clicks intentionally don't trigger the rule-proposal prompt
        // — the chip text is canned advice, not the user's own preference.
        // Clear any prior pending instruction so a stale typed-in proposal
        // doesn't pop up after a chip refinement finishes.
        setPendingRuleText(null);
        setRuleProposalState('idle');
        onSendMessage(buildRefinementPayload(msgs, instruction.trim()), webSearch, {
            essayMode: 'draft',
            sessionId: sessionId || undefined,
        });
    };

    const handleSaveAsRule = async () => {
        if (!pendingRuleText) return;
        setRuleProposalState('saving');
        setRuleProposalError(null);
        try {
            const res = await api.voice.proposeRuleFromRefinement(pendingRuleText);
            setRuleProposalRule(res?.rule || null);
            setRuleProposalState('saved');
        } catch (e) {
            setRuleProposalError(e?.message || 'Could not save rule');
            setRuleProposalState('error');
        }
    };

    const dismissRuleProposal = () => {
        setRuleProposalState('dismissed');
        setPendingRuleText(null);
    };

    const goPrevDraft = () => setFocusedDraftSlot((s) => Math.max(0, s - 1));
    const goNextDraft = () =>
        setFocusedDraftSlot((s) =>
            Math.min(draftMessageIndices.length - 1, s + 1)
        );

    const suggestionChips =
        dynamicSuggestions.length >= 3 ? dynamicSuggestions : REFINEMENT_SUGGESTIONS;

    const dismissEssayFeedback = (submitted) => {
        if (essayFeedbackKey) {
            setEssayFeedbackDoneKey(essayFeedbackKey);
        }
        if (!submitted) {
            setFeedbackRating(null);
            setFeedbackNotes('');
        }
        setFeedbackHoverRating(null);
        setFeedbackError(null);
    };

    const submitEssayFeedback = async () => {
        if (!conversationId) return;
        if (feedbackRating == null && !feedbackNotes.trim()) {
            setFeedbackError('Choose a star rating or add a short note.');
            return;
        }
        setFeedbackError(null);
        setFeedbackSaving(true);
        try {
            await api.essayMemory.submitFeedback(conversationId, {
                rating: feedbackRating,
                feedbackText: feedbackNotes.trim(),
            });
            if (saveFactFromFeedback && feedbackNotes.trim()) {
                try {
                    await api.userFacts.create(feedbackNotes.trim(), 'feedback');
                } catch (e) {
                    console.warn('Could not save profile fact:', e);
                }
            }
            dismissEssayFeedback(true);
            setFeedbackRating(null);
            setFeedbackNotes('');
            setSaveFactFromFeedback(false);
        } catch (e) {
            setFeedbackError(e.message || 'Could not send feedback.');
        } finally {
            setFeedbackSaving(false);
        }
    };

    return (
        <div
            className={`chat-interface${showRefinementDock ? ' chat-interface--refinement' : ''}`}
        >
            {/* Messages Area */}
            <div
                className={`messages-area${showRefinementDock ? ' messages-area--essay-refinement' : ''}`}
                ref={messagesContainerRef}
            >
                {!conversation ? (
                    /* Truly cold — no conversation at all. The
                       top-of-component early return at the
                       !conversation guard usually catches this; this
                       branch is a defensive backup. */
                    <div className="hero-container">
                        <div className="hero-content">
                            <h1>Welcome to MidnightCoffee</h1>
                            <p className="hero-subtitle">
                                The Council is ready to deliberate. <button className="config-link" onClick={() => onOpenSettings('council')}>Configure it</button>
                            </p>
                            <div className="welcome-grid-container">
                                <CouncilGrid models={councilModels} chairman={chairmanModel} status="idle" />
                            </div>
                        </div>
                    </div>
                ) : conversation.messages.length === 0 ? (
                    /* Conversation selected but the full messages
                       haven't loaded yet — handleSelectConversation
                       seeds with messages: [] so we don't show the
                       previous conversation's content during the
                       fetch window. Render a quiet loading hint
                       instead of the Welcome hero (which would
                       falsely suggest the user is on a fresh slate). */
                    <div className="hero-container">
                        <div className="hero-content">
                            <p className="hero-subtitle" style={{ opacity: 0.55 }}>
                                Loading your essay…
                            </p>
                        </div>
                    </div>
                ) : (
                    conversation.messages.map((msg, index) => {
                        // When multiple drafts exist, only show the focused draft
                        // and the single user message that preceded it.
                        if (showRefinementDock && draftMessageIndices.length > 1) {
                            const focusedDraftIdx = draftMessageIndices[focusedDraftSlot];
                            const promptIdx = focusedDraftIdx > 0 ? focusedDraftIdx - 1 : null;
                            if (index !== focusedDraftIdx && index !== promptIdx) {
                                return null;
                            }
                        }

                        const versionLabelForAssistant =
                            showRefinementDock && draftMessageIndices.length > 1 && msg.role === 'assistant'
                                ? `Draft ${focusedDraftSlot + 1} of ${draftMessageIndices.length}`
                                : null;

                        return (
                        <div
                            key={`${conversation.id}-msg-${index}`}
                            id={`essay-msg-${conversation.id}-${index}`}
                            className={`message ${msg.role}`}
                        >
                            <div className="message-role">
                                {msg.role === 'user' ? 'Your Question to the Council' : 'MidnightCoffee'}
                            </div>

                            <div className="message-content">
                                {msg.role === 'user' ? (
                                    <UserBriefMessage content={msg.content} />
                                ) : (
                                    <AssistantMessageBody
                                        msg={msg}
                                        index={index}
                                        isLastMessage={index === conversation.messages.length - 1}
                                        isLoading={isLoading}
                                        onRegenerate={onRegenerate}
                                        onAnswerInterim={onAnswerInterim}
                                        onAbort={onAbort}
                                        activeCouncil={activeCouncil}
                                        activeWordTarget={activeWordTarget}
                                        essayVersionLabel={versionLabelForAssistant}
                                        onFixAll={handleFixAll}
                                        fixingAll={fixingFlagIdx === 'all'}
                                        dismissedFlags={factCheckDismissedSet}
                                        onDismissFlag={handleDismissFlag}
                                        brewingConsoleV2={brewingConsoleV2}
                                    />
                                )}
                            </div>
                        </div>
                    );
                    })
                )}

                {/* Bottom Spacer for floating input */}
                <div ref={messagesEndRef} style={{ height: '20px' }} />
            </div>

            {/* Floating Command Capsule — above feedback strip so “How was this run?” stays visible */}
            <div className="input-area">
                {showEssayFeedbackBar ? (
                    <div className="essay-feedback-strip">
                        <div className="essay-feedback-strip-inner">
                            {feedbackRating == null && !feedbackNotes ? (
                                <div className="essay-feedback-compact-row">
                                    <span className="essay-feedback-compact-label">How was this run?</span>
                                    <div
                                        className="essay-feedback-stars"
                                        role="group"
                                        aria-label="Rating 1 to 5"
                                        onMouseLeave={() => setFeedbackHoverRating(null)}
                                    >
                                        {[1, 2, 3, 4, 5].map((n) => (
                                            <button
                                                key={n}
                                                type="button"
                                                className={`essay-feedback-star ${n <= (feedbackHoverRating ?? feedbackRating ?? 0) ? 'active' : ''}`}
                                                onClick={() => setFeedbackRating(n)}
                                                onMouseEnter={() => setFeedbackHoverRating(n)}
                                                aria-pressed={feedbackRating === n}
                                            >
                                                ★
                                            </button>
                                        ))}
                                    </div>
                                    <button
                                        type="button"
                                        className="essay-feedback-skip"
                                        onClick={() => dismissEssayFeedback(false)}
                                        disabled={feedbackSaving}
                                    >
                                        Skip
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <div className="essay-feedback-compact-row">
                                        <span className="essay-feedback-compact-label">How was this run?</span>
                                        <div
                                            className="essay-feedback-stars"
                                            role="group"
                                            aria-label="Rating 1 to 5"
                                            onMouseLeave={() => setFeedbackHoverRating(null)}
                                        >
                                            {[1, 2, 3, 4, 5].map((n) => (
                                                <button
                                                    key={n}
                                                    type="button"
                                                    className={`essay-feedback-star ${n <= (feedbackHoverRating ?? feedbackRating ?? 0) ? 'active' : ''}`}
                                                    onClick={() => setFeedbackRating(n)}
                                                    onMouseEnter={() => setFeedbackHoverRating(n)}
                                                    aria-pressed={feedbackRating === n}
                                                >
                                                    ★
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <textarea
                                        className="essay-feedback-textarea"
                                        rows={2}
                                        placeholder="Anything we should know? (optional)"
                                        value={feedbackNotes}
                                        onChange={(e) => setFeedbackNotes(e.target.value)}
                                        disabled={feedbackSaving}
                                        autoFocus
                                    />
                                    {feedbackError ? (
                                        <div className="essay-feedback-error">{feedbackError}</div>
                                    ) : null}
                                    <div className="essay-feedback-actions">
                                        <button
                                            type="button"
                                            className="essay-feedback-skip"
                                            onClick={() => dismissEssayFeedback(false)}
                                            disabled={feedbackSaving}
                                        >
                                            Skip
                                        </button>
                                        <button
                                            type="button"
                                            className="essay-feedback-submit"
                                            onClick={submitEssayFeedback}
                                            disabled={feedbackSaving}
                                        >
                                            {feedbackSaving ? 'Sending…' : 'Submit feedback'}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                ) : null}

                {/* Legacy settings.json often has empty council_models while Supabase
                    config is valid — never block the composer during an active run. */}
                {!councilConfigured && !isLoading ? (
                    <div className="input-container config-required">
                        <span className="config-message">
                            ⚠️ Council not ready.
                            <button className="config-link" onClick={() => onOpenSettings('llm_keys')}>Configure API Keys</button>
                            <span className="config-separator">or</span>
                            <button className="config-link" onClick={() => onOpenSettings('council')}>Configure Council</button>
                        </span>
                    </div>
                ) : brewingConsoleV2 &&
                    isLoading &&
                    (!showRefinementDock || refinementDockCollapsed) ? (
                    /* Unified during-run strip. Replaces both the old
                       "Council is revising / Show / Stop" pill and the
                       no-refinement "Council is deliberating" pill so the
                       bottom of the screen reads as one continuous brew
                       rail with the console above. The "Refine" pull-tab
                       only appears when there is actually a refinement
                       dock to pull up.

                       Skipped when the refinement dock is EXPANDED: in that
                       case the user has the form open with their typed
                       refinement, and the form's own loading bar is the
                       right surface to show (we don't want to replace the
                       form they're staring at). */
                    <BrewBar
                        loading={inflightMsg?.loading}
                        progress={inflightMsg?.progress}
                        msg={inflightMsg}
                        aborted={Boolean(inflightMsg?.aborted)}
                        onAbort={onAbort}
                        onExpand={
                            showRefinementDock && refinementDockCollapsed
                                ? () => setRefinementDockCollapsed(false)
                                : null
                        }
                    />
                ) : showRefinementDock && refinementDockCollapsed ? (
                    <div className="composer-status-pill">
                        {isLoading && <span className="composer-status-dot" aria-hidden="true" />}
                        <span className="composer-status-text">
                            {isLoading ? 'Council is revising' : 'Refinement hidden'}
                        </span>
                        <button
                            type="button"
                            className="composer-pill-action"
                            onClick={() => setRefinementDockCollapsed(false)}
                        >
                            Show
                        </button>
                        {isLoading && (
                            <button
                                type="button"
                                className="composer-stop-btn"
                                onClick={onAbort}
                                title="Stop generation"
                            >
                                Stop
                            </button>
                        )}
                    </div>
                ) : !showRefinementDock && isLoading ? (
                    <div className="composer-status-pill">
                        <span className="composer-status-dot" aria-hidden="true" />
                        <span className="composer-status-text">Council is deliberating</span>
                        <button
                            type="button"
                            className="composer-stop-btn"
                            onClick={onAbort}
                            title="Stop generation"
                        >
                            Stop
                        </button>
                    </div>
                ) : showRefinementDock ? (
                    <form
                        className="input-container essay-input essay-refinement-dock"
                        onSubmit={handleSubmit}
                    >
                        {isLoading ? (
                            <div className="refinement-loading-bar">
                                <span className="composer-status-dot" aria-hidden="true" />
                                <span className="refinement-loading-bar-text">Revising…</span>
                                <button
                                    type="button"
                                    className="refinement-dock-collapse-btn"
                                    onClick={() => setRefinementDockCollapsed(true)}
                                >
                                    Hide
                                </button>
                                <button
                                    type="button"
                                    className="composer-stop-btn"
                                    onClick={onAbort}
                                    title="Stop generation"
                                >
                                    Stop
                                </button>
                            </div>
                        ) : null}

                        {draftMessageIndices.length > 1 ? (
                            <div
                                className="essay-draft-nav"
                                role="navigation"
                                aria-label="Essay draft versions"
                            >
                                <button
                                    type="button"
                                    className="essay-draft-nav-btn"
                                    onClick={goPrevDraft}
                                    disabled={isLoading || focusedDraftSlot <= 0}
                                >
                                    ← Previous
                                </button>
                                <span className="essay-draft-nav-label">
                                    Draft {focusedDraftSlot + 1} of {draftMessageIndices.length}
                                </span>
                                <button
                                    type="button"
                                    className="essay-draft-nav-btn"
                                    onClick={goNextDraft}
                                    disabled={
                                        isLoading ||
                                        focusedDraftSlot >= draftMessageIndices.length - 1
                                    }
                                >
                                    Next →
                                </button>
                            </div>
                        ) : null}

                        <div className="refinement-dock-header">
                            <div className="refinement-dock-header-text">
                                <span className="refinement-dock-title">Refine this essay</span>
                                <span className="refinement-dock-sub">
                                    One thread on your topic—the council revises your latest draft below.
                                    Prompts apply to the most recent essay in this conversation.
                                </span>
                            </div>
                            <div className="refinement-dock-header-actions">
                                <button
                                    type="button"
                                    className="refinement-dock-collapse-btn"
                                    onClick={() => setRefinementDockCollapsed(true)}
                                    disabled={isLoading}
                                    title="Hide refinement panel"
                                >
                                    Hide
                                </button>
                                <button
                                    type="button"
                                    className="config-link essay-voice-rules-link"
                                    onClick={() => onOpenSettings('voice')}
                                    title="Open Settings → My Voice"
                                >
                                    Voice rules
                                </button>
                            </div>
                        </div>

                        {isLoading && (
                            <div className="refinement-loading-hint">
                                Council is updating your essay…
                            </div>
                        )}

                        {!isLoading && pendingRuleText && ruleProposalState !== 'idle' && ruleProposalState !== 'dismissed' ? (
                            <div
                                className={`refinement-rule-proposal refinement-rule-proposal--${ruleProposalState}`}
                                role="status"
                                aria-live="polite"
                            >
                                {ruleProposalState === 'asking' ? (
                                    <>
                                        <div className="refinement-rule-proposal-text">
                                            <span className="refinement-rule-proposal-title">
                                                Save this as a rule for future essays?
                                            </span>
                                            <span className="refinement-rule-proposal-instr">
                                                “{pendingRuleText.length > 220
                                                    ? pendingRuleText.slice(0, 217) + '…'
                                                    : pendingRuleText}”
                                            </span>
                                        </div>
                                        <div className="refinement-rule-proposal-actions">
                                            <button
                                                type="button"
                                                className="refinement-rule-btn refinement-rule-btn--primary"
                                                onClick={handleSaveAsRule}
                                            >
                                                Save as rule
                                            </button>
                                            <button
                                                type="button"
                                                className="refinement-rule-btn"
                                                onClick={dismissRuleProposal}
                                            >
                                                Not now
                                            </button>
                                        </div>
                                    </>
                                ) : ruleProposalState === 'saving' ? (
                                    <span className="refinement-rule-proposal-text">
                                        Saving rule…
                                    </span>
                                ) : ruleProposalState === 'saved' ? (
                                    <>
                                        <span className="refinement-rule-proposal-text">
                                            ✓ {ruleProposalRule
                                                ? <>Added to pending rules: <em>“{ruleProposalRule}”</em></>
                                                : 'Saved.'}
                                            <span className="refinement-rule-hint">
                                                {' '}Review in Settings → Voice rules.
                                            </span>
                                        </span>
                                        <button
                                            type="button"
                                            className="refinement-rule-btn"
                                            onClick={dismissRuleProposal}
                                        >
                                            Dismiss
                                        </button>
                                    </>
                                ) : ruleProposalState === 'error' ? (
                                    <>
                                        <span className="refinement-rule-proposal-text">
                                            Couldn't save rule: {ruleProposalError}
                                        </span>
                                        <div className="refinement-rule-proposal-actions">
                                            <button
                                                type="button"
                                                className="refinement-rule-btn refinement-rule-btn--primary"
                                                onClick={handleSaveAsRule}
                                            >
                                                Retry
                                            </button>
                                            <button
                                                type="button"
                                                className="refinement-rule-btn"
                                                onClick={dismissRuleProposal}
                                            >
                                                Dismiss
                                            </button>
                                        </div>
                                    </>
                                ) : null}
                            </div>
                        ) : null}

                        <div className="input-row-top">
                            <label
                                className={`search-toggle ${webSearch ? 'active' : ''}`}
                                title="Toggle web search for this refinement"
                            >
                                <input
                                    type="checkbox"
                                    className="search-checkbox"
                                    checked={webSearch}
                                    onChange={() => setWebSearch(!webSearch)}
                                    disabled={isLoading}
                                />
                                <span className="search-icon">🌐</span>
                                {webSearch && <span className="search-label">Search On</span>}
                            </label>

                            <textarea
                                className="message-input refinement-prompt-input"
                                placeholder={
                                    isLoading
                                        ? 'Council is deliberating…'
                                        : 'Your refinement (e.g. “Make the turn in paragraph 3 more explicit”)'
                                }
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                disabled={isLoading}
                                rows={3}
                                style={{
                                    height: 'auto',
                                    minHeight: '88px',
                                }}
                            />

                            <MicButton
                                value={input}
                                onChange={setInput}
                                disabled={isLoading}
                                showLabel
                                title="Talk through what you want changed"
                            />

                            {isLoading ? (
                                <button
                                    type="button"
                                    className="send-button stop-button"
                                    onClick={onAbort}
                                    title="Stop generation"
                                >
                                    ⏹
                                </button>
                            ) : (
                                <button type="submit" className="send-button" disabled={!input.trim()}>
                                    ➤
                                </button>
                            )}
                        </div>
                    </form>
                ) : (
                    <form
                        className={`input-container essay-input essay-input-${essayMode}`}
                        onSubmit={handleSubmit}
                    >
                        <div className="essay-mode-toggle" role="tablist" aria-label="Essay input mode">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={essayMode === 'topic'}
                                className={`essay-mode-btn ${essayMode === 'topic' ? 'active' : ''}`}
                                onClick={() => onEssayModeChange?.('topic')}
                                title="Write from scratch"
                            >
                                <span className="essay-mode-icon">✎</span>
                                Topic
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={essayMode === 'draft'}
                                className={`essay-mode-btn ${essayMode === 'draft' ? 'active' : ''}`}
                                onClick={() => onEssayModeChange?.('draft')}
                                title="Paste your draft; the council refines it"
                            >
                                <span className="essay-mode-icon">✦</span>
                                Draft
                            </button>
                            <span className="essay-mode-hint">
                                {essayMode === 'topic'
                                    ? 'Writes from scratch.'
                                    : 'Refines your draft, keeps your voice.'}
                            </span>
                        </div>

                        <div className="input-row-top">
                            <label className={`search-toggle ${webSearch ? 'active' : ''}`} title="Toggle Web Search">
                                <input
                                    type="checkbox"
                                    className="search-checkbox"
                                    checked={webSearch}
                                    onChange={() => setWebSearch(!webSearch)}
                                />
                                <span className="search-icon">🌐</span>
                                {webSearch && <span className="search-label">Search On</span>}
                            </label>

                            <textarea
                                className="message-input"
                                placeholder={
                                    essayMode === 'draft'
                                        ? 'Paste your draft here.'
                                        : 'What essay do you want to write?'
                                }
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                rows={essayMode === 'draft' ? 6 : 2}
                                style={{
                                    height: 'auto',
                                    minHeight: essayMode === 'draft' ? '140px' : '48px',
                                }}
                            />

                            <MicButton
                                value={input}
                                onChange={setInput}
                                showLabel
                                title={
                                    essayMode === 'draft'
                                        ? 'Talk through your draft'
                                        : 'Talk through your essay topic'
                                }
                            />

                            <button type="submit" className="send-button" disabled={!input.trim()}>
                                ➤
                            </button>
                        </div>

                        </form>
                )}
            </div>
        </div>
    );
}

/**
 * Renders the assistant side of a message.
 *
 *   While loading: a single terminal-style status panel (no raw drafts).
 *   When done: only the final essay; raw council notes are tucked behind
 *   the FinalEssay "Show council notes" toggle.
 */
function AssistantMessageBody({
    msg,
    index,
    isLastMessage,
    isLoading,
    onRegenerate,
    onAnswerInterim,
    onAbort,
    activeCouncil = null,
    activeWordTarget = null,
    essayVersionLabel = null,
    // Fact-check "Fix all" props — owned by ChatInterface state.
    // AssistantMessageBody just forwards them down to FinalEssay.
    onFixAll = null,
    fixingAll = false,
    dismissedFlags = null,
    onDismissFlag = null,
    // brewingConsoleV2 = swap EssayLoadingStatus for the new BrewingConsole
    // and let it absorb the persona-chip row.
    brewingConsoleV2 = false,
}) {
    // Track the whole stream lifecycle, not individual stage flags — the
    // backend yields events between stages (interim questions, the Flash
    // pickers, the chairman's 25s clarification wait) where all loading.*
    // are false. Gating on those flags makes the InterimQuestions side
    // panel and EssayLoadingStatus disappear mid-run.
    const isStreaming = isLastMessage && isLoading && !msg.stage3;
    // Persona chip row visible during generation. Falls back to null when
    // we don't know which council ran.
    const chipState = isLastMessage ? buildChipState(activeCouncil, msg) : null;

    // Council notes (pitch race + spine pick + Stage 1 drafts + Stage 2
    // critiques) are hidden by default and shown through the FinalEssay's
    // toggle once the essay is ready. Each subsection is gated on its own
    // data being present so older essays without the new fields still render.
    const hasAnyCouncilData =
        msg.stage1 || msg.stage2 || msg.pitches || msg.pickedSpine;
    const councilNotes = hasAnyCouncilData ? (
        <>
            {msg.pitches && msg.pitches.length > 0 && (
                <PitchSummary
                    pitches={msg.pitches}
                    pickedPitch={msg.pickedPitch}
                />
            )}
            {msg.pickedSpine && <SpinePick pickedSpine={msg.pickedSpine} />}
            {msg.stage1 && (
                <Stage1
                    responses={msg.stage1}
                    startTime={msg.timers?.stage1Start}
                    endTime={msg.timers?.stage1End}
                />
            )}
            {msg.stage2 && (
                <Stage2
                    rankings={msg.stage2}
                    labelToModel={msg.metadata?.label_to_model}
                    aggregateRankings={msg.metadata?.aggregate_rankings}
                    startTime={msg.timers?.stage2Start}
                    endTime={msg.timers?.stage2End}
                />
            )}
        </>
    ) : null;

    return (
        <>
            {msg.metadata?.search_error && (
                <div className="search-warning" role="status">
                    <span className="search-warning__icon" aria-hidden="true">⚠️</span>
                    <span>
                        {msg.metadata.search_error.message ||
                            'Web search failed — council ran without web context.'}
                    </span>
                </div>
            )}
            {msg.metadata?.search_context && (
                <SearchContext
                    searchQuery={msg.metadata?.search_query}
                    extractedQuery={msg.metadata?.extracted_query}
                    searchContext={msg.metadata?.search_context}
                />
            )}

            {/* CouncilChips are folded into BrewingConsole when brewingConsoleV2
                is on, so we only render the standalone chip row in the legacy path. */}
            {!brewingConsoleV2 && chipState && (isStreaming || !msg.stage3) && (
                <CouncilChips
                    personas={chipState.personas}
                    chairman={chipState.chairman}
                    stage={chipState.stage}
                    stage1Done={chipState.stage1Done}
                    wordTarget={activeWordTarget}
                />
            )}

            {isStreaming && !msg.stage3 && (
                brewingConsoleV2 ? (
                    <BrewingConsole
                        loading={msg.loading}
                        progress={msg.progress}
                        msg={msg}
                        aborted={Boolean(msg.aborted)}
                        onAbort={onAbort}
                        chipState={chipState}
                        webSearched={Boolean(msg.metadata?.search_context)}
                    />
                ) : (
                    <EssayLoadingStatus
                        loading={msg.loading}
                        progress={msg.progress}
                        msg={msg}
                        onAbort={onAbort}
                    />
                )
            )}

            {/* Render the panel for the entire streaming window so the user
                sees a "questions are coming" placeholder before the first
                interim_question SSE event lands (typically a few seconds
                in). Also stays visible briefly after the run finishes if
                any question is still pending — surfaces the "saved for
                next time" lock state instead of silently disappearing. */}
            {((isStreaming && !msg.stage3) ||
                (msg.runFinished && msg.interimQuestions?.some((q) => q.status === 'pending'))) && (
                <InterimQuestions
                    questions={msg.interimQuestions || []}
                    onAnswer={onAnswerInterim}
                    runFinished={Boolean(msg.runFinished)}
                    runFinishedReason={msg.runFinishedReason}
                />
            )}

            {msg.stage3 && (
                <FinalEssay
                    finalResponse={msg.stage3}
                    startTime={msg.timers?.stage3Start}
                    endTime={msg.timers?.stage3End}
                    councilNotes={councilNotes}
                    onRegenerate={onRegenerate}
                    canRegenerate={Boolean(onRegenerate) && !isLoading && isLastMessage}
                    versionLabel={essayVersionLabel}
                    factCheckFlags={
                        msg.factCheckFlags || msg.metadata?.fact_check_flags || null
                    }
                    factCheckRunning={Boolean(msg.factCheckRunning)}
                    detectionScore={
                        msg.detectionScore || msg.metadata?.detection_score || null
                    }
                    detectionScoreRunning={Boolean(msg.detectionScoreRunning)}
                    onFixAll={isLastMessage ? onFixAll : null}
                    fixingAll={isLastMessage && fixingAll}
                    dismissedFlags={isLastMessage ? dismissedFlags : null}
                    onDismissFlag={isLastMessage ? onDismissFlag : null}
                />
            )}

            {msg.aborted && (
                <div className="aborted-indicator">
                    <span className="aborted-icon">⏹</span>
                    <span className="aborted-text">
                        Generation stopped by user.
                        {msg.stage1 && !msg.stage3 && ' Partial drafts are available under "Show council notes".'}
                    </span>
                </div>
            )}

            {/* If stopped before chairman synthesis, expose council notes inline */}
            {!msg.stage3 && msg.aborted && (msg.stage1 || msg.stage2) && (
                <details className="aborted-fallback-notes">
                    <summary>Show partial council notes</summary>
                    <div style={{ marginTop: '12px' }}>
                        {msg.stage1 && (
                            <Stage1
                                responses={msg.stage1}
                                startTime={msg.timers?.stage1Start}
                                endTime={msg.timers?.stage1End}
                            />
                        )}
                        {msg.stage2 && (
                            <Stage2
                                rankings={msg.stage2}
                                labelToModel={msg.metadata?.label_to_model}
                                aggregateRankings={msg.metadata?.aggregate_rankings}
                                startTime={msg.timers?.stage2Start}
                                endTime={msg.timers?.stage2End}
                            />
                        )}
                    </div>
                </details>
            )}
        </>
    );
}
