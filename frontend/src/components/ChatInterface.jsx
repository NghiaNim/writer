import StageTimer from './StageTimer';
import { useState, useEffect, useRef } from 'react';
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

export default function ChatInterface({
    conversation,
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
    const messagesEndRef = useRef(null);
    const messagesContainerRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    // Only auto-scroll if user is already near the bottom
    // This prevents interrupting reading when new content arrives
    useEffect(() => {
        if (!messagesContainerRef.current) return;

        const container = messagesContainerRef.current;
        const isNearBottom =
            container.scrollHeight - container.scrollTop - container.clientHeight < 150;

        // Auto-scroll only if user is already at/near bottom
        if (isNearBottom) {
            scrollToBottom();
        }
    }, [conversation]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (input.trim() && !isLoading) {
            onSendMessage(input, webSearch);
            setInput('');
        }
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

    return (
        <div className="chat-interface">
            {/* Messages Area */}
            <div className="messages-area" ref={messagesContainerRef}>
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
                    conversation.messages.map((msg, index) => (
                        <div key={`${conversation.id}-msg-${index}`} className={`message ${msg.role}`}>
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
                                    />
                                )}
                            </div>
                        </div>
                    ))
                )}

                {/* Bottom Spacer for floating input */}
                <div ref={messagesEndRef} style={{ height: '20px' }} />
            </div>

            {/* Floating Command Capsule */}
            <div className="input-area">
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
                ) : (
                    <form
                        className={`input-container essay-input essay-input-${essayMode}`}
                        onSubmit={handleSubmit}
                    >
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
