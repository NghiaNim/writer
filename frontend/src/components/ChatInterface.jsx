import StageTimer from './StageTimer';
import { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import SearchContext from './SearchContext';
import Stage1, { Stage1Skeleton } from './Stage1';
import Stage2, { Stage2Skeleton } from './Stage2';
import Stage3, { Stage3Skeleton } from './Stage3';
import CouncilGrid from './CouncilGrid';
import CouncilChips from './CouncilChips';
import ExecutionModeToggle from './ExecutionModeToggle';
import EssayLoadingStatus from './EssayLoadingStatus';
import FinalEssay from './FinalEssay';
import { api } from '../api';
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

    let stage = 'idle';
    if (msg?.loading?.search) stage = 'search';
    if (msg?.loading?.stage1) stage = 'stage1';
    if (msg?.loading?.stage2) stage = 'stage2';
    if (msg?.loading?.stage3) stage = 'stage3';
    if (msg?.stage3) stage = 'done';

    const stage1Done = Math.min(
        personas.length,
        msg?.progress?.stage1?.count || 0
    );
    return { personas, chairman, stage, stage1Done };
}

// Phase 3: in 'full' mode (the essay flow) we hide deliberation by default
// and show only the final essay. chat_only / chat_ranking modes still use
// the legacy stage-by-stage UI so users can inspect drafts/rankings.
function shouldUseEssayUX(msg, currentExecutionMode) {
    const mode = msg?.metadata?.execution_mode || currentExecutionMode || 'full';
    return mode === 'full';
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
    isLoading,
    councilConfigured,
    onOpenSettings,
    councilModels = [],
    chairmanModel = null,
    executionMode,
    onExecutionModeChange,
    essayMode = 'topic',
    onEssayModeChange,
    searchProvider = 'duckduckgo',
    activeCouncil = null,
    activeWordTarget = null,
}) {
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

    const draftMessageIndices = useMemo(() => {
        const list = conversation?.messages || [];
        return list
            .map((m, i) =>
                m.role === 'assistant' && stage3EssayText(m).trim() ? i : null
            )
            .filter((i) => i != null);
    }, [conversation]);

    const draftNavKey = draftMessageIndices.join(',');

    const showRefinementDock =
        Boolean(conversation) &&
        executionMode === 'full' &&
        draftMessageIndices.length > 0 &&
        councilConfigured;

    const essayFeedbackKey = useMemo(() => {
        if (!conversationId || !conversation?.messages?.length) return null;
        const m = conversation.messages;
        const li = m.length - 1;
        const lm = m[li];
        if (
            lm?.role !== 'assistant' ||
            !lm?.stage3 ||
            isLoading ||
            !shouldUseEssayUX(lm, executionMode)
        ) {
            return null;
        }
        return `${conversationId}-${li}`;
    }, [conversation, conversationId, isLoading, executionMode]);

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
    }, [conversationId]);

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
            onSendMessage(buildRefinementPayload(list, input.trim()), webSearch, {
                essayMode: 'draft',
                sessionId: sessionId || undefined,
            });
        } else {
            onSendMessage(input, webSearch);
        }
        setInput('');
    };

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
        onSendMessage(buildRefinementPayload(msgs, instruction.trim()), webSearch, {
            essayMode: 'draft',
            sessionId: sessionId || undefined,
        });
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
                {(!conversation || conversation.messages.length === 0) ? (
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
                                    <div className="markdown-content">
                                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                                    </div>
                                ) : (
                                    <AssistantMessageBody
                                        msg={msg}
                                        index={index}
                                        isLastMessage={index === conversation.messages.length - 1}
                                        currentExecutionMode={executionMode}
                                        searchProvider={searchProvider}
                                        councilModels={councilModels}
                                        chairmanModel={chairmanModel}
                                        isLoading={isLoading}
                                        onRegenerate={onRegenerate}
                                        activeCouncil={activeCouncil}
                                        activeWordTarget={activeWordTarget}
                                        essayVersionLabel={versionLabelForAssistant}
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
            <div
                className={`input-area ${
                    !showRefinementDock && composerCollapsed && isLoading
                        ? 'input-area-composer-collapsed'
                        : ''
                }`}
            >
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
                ) : showRefinementDock && refinementDockCollapsed ? (
                    <div className="input-container input-composer-collapsed-strip">
                        <button
                            type="button"
                            className="composer-expand-btn"
                            onClick={() => setRefinementDockCollapsed(false)}
                            title="Show refinement panel"
                        >
                            Expand refinement
                        </button>
                        <span className="composer-collapsed-hint">
                            {isLoading
                                ? 'Council is updating your essay'
                                : 'Refinement hidden — more room to read'}
                        </span>
                        {isLoading ? (
                            <button
                                type="button"
                                className="send-button stop-button"
                                onClick={onAbort}
                                title="Stop generation"
                            >
                                ⏹
                            </button>
                        ) : null}
                    </div>
                ) : !showRefinementDock && isLoading && composerCollapsed ? (
                    <div className="input-container input-composer-collapsed-strip">
                        <button
                            type="button"
                            className="composer-expand-btn"
                            onClick={() => setComposerCollapsed(false)}
                            title="Show topic/draft input and mode controls"
                        >
                            Show composer
                        </button>
                        <span className="composer-collapsed-hint">Drafting in progress</span>
                        <button
                            type="button"
                            className="send-button stop-button"
                            onClick={onAbort}
                            title="Stop generation"
                        >
                            ⏹
                        </button>
                    </div>
                ) : showRefinementDock ? (
                    <form
                        className="input-container essay-input essay-refinement-dock"
                        onSubmit={handleSubmit}
                    >
                        {isLoading ? (
                            <div className="composer-minimize-bar">
                                <span className="composer-minimize-hint">
                                    Hide this panel to read earlier drafts above.
                                </span>
                                <button
                                    type="button"
                                    className="composer-minimize-btn"
                                    onClick={() => setRefinementDockCollapsed(true)}
                                    title="Hide refinement panel"
                                >
                                    Hide refinement
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
                                    disabled={isLoading}
                                    title="Open Settings → My Voice"
                                >
                                    Voice rules
                                </button>
                            </div>
                        </div>

                        {!isLoading ? (
                            suggestionsLoading ? (
                                <div
                                    className="refinement-suggestions refinement-suggestions--loading"
                                    role="status"
                                >
                                    Tailoring suggestions to your essay…
                                </div>
                            ) : (
                                <div
                                    className="refinement-suggestions"
                                    role="group"
                                    aria-label="Suggested refinements"
                                >
                                    {suggestionChips.map(({ label, instruction }, idx) => (
                                        <button
                                            key={`${label}-${idx}`}
                                            type="button"
                                            className="refinement-chip"
                                            disabled={isLoading}
                                            onClick={() => sendRefinementSuggestion(instruction)}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            )
                        ) : (
                            <div className="refinement-loading-hint">
                                Council is updating your essay…
                            </div>
                        )}

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
                        {isLoading ? (
                            <div className="composer-minimize-bar">
                                <span className="composer-minimize-hint">
                                    Hide this panel to see council status above.
                                </span>
                                <button
                                    type="button"
                                    className="composer-minimize-btn"
                                    onClick={() => setComposerCollapsed(true)}
                                    title="Collapse the composer while the council runs"
                                >
                                    Hide composer
                                </button>
                            </div>
                        ) : null}
                        {/* Phase 4: Topic / Draft mode toggle on top */}
                        <div className="essay-mode-toggle" role="tablist" aria-label="Essay input mode">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={essayMode === 'topic'}
                                className={`essay-mode-btn ${essayMode === 'topic' ? 'active' : ''}`}
                                onClick={() => onEssayModeChange?.('topic')}
                                disabled={isLoading}
                                title="Give the council a topic to write about from scratch"
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
                                disabled={isLoading}
                                title="Paste your own draft; the council refines it while preserving your voice"
                            >
                                <span className="essay-mode-icon">✦</span>
                                Draft
                            </button>
                            <span className="essay-mode-hint">
                                {essayMode === 'topic'
                                    ? 'The council will write from scratch.'
                                    : 'The council will refine your draft and preserve your voice.'}
                            </span>
                            <button
                                type="button"
                                className="config-link essay-voice-rules-link"
                                onClick={() => onOpenSettings('voice')}
                                disabled={isLoading}
                                title="Open Settings → My Voice: rules and reference paragraphs for every essay"
                            >
                                Voice rules
                            </button>
                        </div>

                        <div className="input-row-top">
                            <label className={`search-toggle ${webSearch ? 'active' : ''}`} title="Toggle Web Search">
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
                                className="message-input"
                                placeholder={
                                    isLoading
                                        ? 'Council is deliberating...'
                                        : essayMode === 'draft'
                                            ? 'Paste your draft here. The council will refine it while preserving your voice.'
                                            : 'What essay do you want to write? (e.g. "Why most productivity advice fails for creatives")'
                                }
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                disabled={isLoading}
                                rows={essayMode === 'draft' ? 6 : 2}
                                style={{
                                    height: 'auto',
                                    minHeight: essayMode === 'draft' ? '140px' : '48px',
                                }}
                            />

                            {isLoading ? (
                                <button type="button" className="send-button stop-button" onClick={onAbort} title="Stop Generation">
                                    ⏹
                                </button>
                            ) : (
                                <button type="submit" className="send-button" disabled={!input.trim()}>
                                    ➤
                                </button>
                            )}
                        </div>

                        <div className="input-row-bottom">
                            <ExecutionModeToggle
                                value={executionMode}
                                onChange={onExecutionModeChange}
                                disabled={isLoading}
                            />
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
 * In the essay UX (full mode):
 *   - While loading: shows a single terminal-style status panel (no raw drafts).
 *   - When done: shows ONLY the final essay; raw council notes are tucked
 *     behind a "Show council notes" toggle.
 *
 * In chat_only / chat_ranking modes: falls back to the legacy stage-by-stage
 * UI so users can still inspect drafts and rankings directly.
 */
function AssistantMessageBody({
    msg,
    index,
    isLastMessage,
    currentExecutionMode,
    searchProvider,
    councilModels,
    chairmanModel,
    isLoading,
    onRegenerate,
    activeCouncil = null,
    activeWordTarget = null,
    essayVersionLabel = null,
}) {
    const useEssay = shouldUseEssayUX(msg, currentExecutionMode);
    const isStreaming =
        isLastMessage &&
        isLoading &&
        (msg.loading?.search ||
            msg.loading?.stage1 ||
            msg.loading?.stage2 ||
            msg.loading?.stage3);
    // Extension #1 ("show the mechanism"): persona chip row visible during
    // generation. Falls back to null when we don't know which council ran.
    const chipState = isLastMessage ? buildChipState(activeCouncil, msg) : null;

    const searchProviderName =
        searchProvider === 'duckduckgo'
            ? 'DuckDuckGo'
            : searchProvider === 'tavily'
                ? 'Tavily'
                : searchProvider === 'brave'
                    ? 'Brave'
                    : 'Provider';

    if (useEssay) {
        // Council notes (Stage 1 + Stage 2) are hidden by default and shown
        // through the FinalEssay's toggle once the essay is ready.
        const councilNotes = (msg.stage1 || msg.stage2) ? (
            <>
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
                {msg.metadata?.search_context && (
                    <SearchContext
                        searchQuery={msg.metadata?.search_query}
                        extractedQuery={msg.metadata?.extracted_query}
                        searchContext={msg.metadata?.search_context}
                    />
                )}

                {chipState && (isStreaming || !msg.stage3) && (
                    <CouncilChips
                        personas={chipState.personas}
                        chairman={chipState.chairman}
                        stage={chipState.stage}
                        stage1Done={chipState.stage1Done}
                        wordTarget={activeWordTarget}
                    />
                )}

                {isStreaming && !msg.stage3 && (
                    <EssayLoadingStatus
                        loading={msg.loading}
                        progress={msg.progress}
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

    // Legacy (chat_only / chat_ranking) UX: keep existing stage-by-stage rendering.
    return (
        <>
            {msg.loading?.search && (
                <div className="stage-loading">
                    <div className="spinner"></div>
                    <span>🔍 Searching the web with {searchProviderName}...</span>
                </div>
            )}

            {msg.metadata?.search_context && (
                <SearchContext
                    searchQuery={msg.metadata?.search_query}
                    extractedQuery={msg.metadata?.extracted_query}
                    searchContext={msg.metadata?.search_context}
                />
            )}

            {(msg.loading?.stage1 || (msg.stage1 && !msg.stage2)) && (
                <div className="stage-container">
                    <div className="stage-header">
                        <h3>Stage 1: Council Deliberation</h3>
                        {msg.timers?.stage1Start && (
                            <StageTimer
                                startTime={msg.timers.stage1Start}
                                endTime={msg.timers.stage1End}
                            />
                        )}
                    </div>
                    <CouncilGrid
                        models={councilModels}
                        chairman={chairmanModel}
                        status={msg.loading?.stage1 ? 'thinking' : 'complete'}
                        progress={{
                            currentModel: msg.progress?.stage1?.currentModel,
                            completed: msg.stage1?.map((r) => r.model) || [],
                        }}
                    />
                </div>
            )}

            {(msg.loading?.stage1 || (msg.stage1 && !msg.stage2))
                ? msg.loading?.stage1 && !msg.stage1
                    ? <Stage1Skeleton />
                    : msg.stage1 && (
                        <Stage1
                            responses={msg.stage1}
                            startTime={msg.timers?.stage1Start}
                            endTime={msg.timers?.stage1End}
                        />
                    )
                : null}

            {msg.loading?.stage2 && <Stage2Skeleton />}
            {msg.stage2 && (
                <Stage2
                    rankings={msg.stage2}
                    labelToModel={msg.metadata?.label_to_model}
                    aggregateRankings={msg.metadata?.aggregate_rankings}
                    startTime={msg.timers?.stage2Start}
                    endTime={msg.timers?.stage2End}
                />
            )}

            {msg.loading?.stage3 && <Stage3Skeleton />}
            {msg.stage3 && (
                <Stage3
                    finalResponse={msg.stage3}
                    startTime={msg.timers?.stage3Start}
                    endTime={msg.timers?.stage3End}
                />
            )}

            {msg.aborted && (
                <div className="aborted-indicator">
                    <span className="aborted-icon">⏹</span>
                    <span className="aborted-text">
                        Generation stopped by user.
                        {msg.stage1 && !msg.stage3 && ' Partial results shown above.'}
                    </span>
                </div>
            )}
        </>
    );
}
