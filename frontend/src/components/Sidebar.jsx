import React, { useState, useMemo, useRef, useEffect } from 'react';
import MidnightLogo from './MidnightLogo';
import './Sidebar.css';

/**
 * Render-time cleanup for conversation titles. Strips any residual
 * "TOPIC:" / "DRAFT:" prefix and collapses to the first non-empty line.
 * Old conversations created before the backend started polishing titles
 * via Flash carry raw form payload as their "title" — this helper makes
 * them readable without a migration.
 */
function cleanTitle(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/^(topic|draft)\s*:\s*/i, '');
  const nl = s.indexOf('\n');
  if (nl > 0) s = s.slice(0, nl).trim();
  return s.trim();
}

// Compact labels for the "Drafts in progress" rows. Mirrors the
// frontend's STEP_ORDER but stripped to fit in the sidebar — "Step N ·
// short label" reads better in a narrow column than full step titles.
const STEP_LABELS_SHORT = {
  topic: 'Step 1 · Topic',
  brainstorm: 'Step 1 · Brainstorming',
  draft: 'Step 1 · Draft mode',
  questions: 'Step 2 · Questions',
  core_idea: 'Step 3 · Core idea',
  timeline: 'Step 4 · Timeline',
  voice: 'Step 5 · Voice',
};

function formatRelativeTime(date) {
  if (!(date instanceof Date)) return '';
  const diffMs = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diffMs < minute) return 'just now';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return date.toLocaleDateString();
}

export default function Sidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onOpenSettings,
  isLoading,
  onAbort,
  isOpen,
  onClose,
  // Optional: set of conversation IDs that are currently streaming. When
  // omitted, falls back to "isLoading && active conversation" which is
  // what the single-stream world tracked. Populated for real once
  // parallel-session support lands.
  streamingIds,
  // True unless we're at the soft cap on concurrent streams. Controls
  // the New Discussion button so the user can fan out parallel essays
  // while existing ones are still drafting. When false, the button
  // surfaces a tooltip explaining why.
  canStartNewConversation = true,
  maxConcurrentStreams = 3,
  // "Drafts in progress" section — unfinished essay_sessions with
  // metadata. Click to resume; trash to delete.
  inProgressSessions = [],
  currentSessionId = null,
  onResumeSession,
  onDeleteSession,
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [confirmingDeleteSession, setConfirmingDeleteSession] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // The sidebar surfaces two related but distinct lists: unfinished
  // "Drafts in progress" (essay_sessions) and "Past essays" (completed
  // conversations). Two layout modes for them:
  //
  //   viewMode = 'sections' — both visible at once, each collapsible.
  //                           Best for at-a-glance scanning, mirrors
  //                           Linear's section pattern.
  //   viewMode = 'tabs'      — only one list visible. Activated via a
  //                           top-of-sidebar tab strip. Best for narrow
  //                           screens or users with many of both.
  //
  // All four pieces of UI state (mode + per-section expanded + active
  // tab) persist to localStorage so the user's choice survives reload.
  const VIEW_MODE_KEY = 'mc.sidebar.viewMode';
  const DRAFTS_EXPANDED_KEY = 'mc.sidebar.draftsExpanded';
  const ESSAYS_EXPANDED_KEY = 'mc.sidebar.essaysExpanded';
  const ACTIVE_TAB_KEY = 'mc.sidebar.activeTab';

  const loadFlag = (key, defaultValue) => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored == null) return defaultValue;
      if (defaultValue === true || defaultValue === false) return stored === 'true';
      return stored;
    } catch {
      return defaultValue;
    }
  };
  const persistFlag = (key, value) => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // localStorage disabled (private mode) — lose persistence quietly.
    }
  };

  const [viewMode, setViewMode] = useState(() => loadFlag(VIEW_MODE_KEY, 'sections'));
  const [draftsExpanded, setDraftsExpanded] = useState(() => loadFlag(DRAFTS_EXPANDED_KEY, true));
  const [essaysExpanded, setEssaysExpanded] = useState(() => loadFlag(ESSAYS_EXPANDED_KEY, true));
  const [activeTab, setActiveTab] = useState(() => loadFlag(ACTIVE_TAB_KEY, 'drafts'));

  // Resizable split between drafts and essays. `null` means "auto" —
  // the drafts section uses its intrinsic height up to a CSS max. As
  // soon as the user drags the splitter we switch to an explicit
  // height in pixels and persist it.
  const DRAFTS_HEIGHT_KEY = 'mc.sidebar.draftsHeightPx';
  const [draftsHeightPx, setDraftsHeightPx] = useState(() => {
    try {
      const stored = window.localStorage.getItem(DRAFTS_HEIGHT_KEY);
      if (!stored) return null;
      const n = parseInt(stored, 10);
      return Number.isFinite(n) && n >= 80 ? n : null;
    } catch {
      return null;
    }
  });
  const draftsRef = useRef(null);

  // Pointer events (instead of mouse events) so touch and stylus on
  // tablets/phones can drag the splitter too. setPointerCapture keeps
  // events flowing even when the pointer leaves the thin handle strip.
  const handleResizeStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startHeight = draftsRef.current?.getBoundingClientRect().height || 200;
    const maxHeight = window.innerHeight * 0.7;
    const minHeight = 80;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Older browsers / non-pointer paths — events still bubble fine.
    }

    const onMove = (ev) => {
      const delta = ev.clientY - startY;
      const next = Math.max(minHeight, Math.min(maxHeight, startHeight + delta));
      setDraftsHeightPx(next);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // ok
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  // Persist the resized height after the user releases the drag.
  // We debounce via the effect itself (runs once per settled value).
  useEffect(() => {
    if (draftsHeightPx == null) return;
    persistFlag(DRAFTS_HEIGHT_KEY, draftsHeightPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftsHeightPx]);

  const setViewModeAndPersist = (next) => {
    setViewMode(next);
    persistFlag(VIEW_MODE_KEY, next);
  };
  const setActiveTabAndPersist = (next) => {
    setActiveTab(next);
    persistFlag(ACTIVE_TAB_KEY, next);
  };
  const toggleDraftsExpanded = () => {
    setDraftsExpanded((cur) => {
      const next = !cur;
      persistFlag(DRAFTS_EXPANDED_KEY, next);
      return next;
    });
  };
  const toggleEssaysExpanded = () => {
    setEssaysExpanded((cur) => {
      const next = !cur;
      persistFlag(ESSAYS_EXPANDED_KEY, next);
      return next;
    });
  };

  const isConversationStreaming = (convId) => {
    if (streamingIds && typeof streamingIds.has === 'function') {
      return streamingIds.has(convId);
    }
    return !!isLoading && convId === currentConversationId;
  };

  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.toLowerCase();
    return conversations.filter((conv) =>
      cleanTitle(conv.title || 'New Conversation').toLowerCase().includes(q)
    );
  }, [conversations, searchQuery]);

  // Search also covers in-progress drafts so users can find an essay
  // they started yesterday by typing its topic. Matches the same case-
  // insensitive substring rule as essays. When the search box is empty
  // this just returns the raw list unchanged.
  const filteredDrafts = useMemo(() => {
    if (!searchQuery.trim()) return inProgressSessions;
    const q = searchQuery.toLowerCase();
    return (inProgressSessions || []).filter((s) =>
      (s.topic || '').toLowerCase().includes(q)
    );
  }, [inProgressSessions, searchQuery]);

  const handleAbortClick = (e) => {
    e.stopPropagation();
    onAbort();
  };

  const handleDeleteClick = (e, convId) => {
    e.stopPropagation();
    setConfirmingDelete(convId);
  };

  const handleConfirmDelete = (e, convId) => {
    e.stopPropagation();
    onDeleteConversation(convId);
    setConfirmingDelete(null);
  };

  const handleCancelDelete = (e) => {
    e.stopPropagation();
    setConfirmingDelete(null);
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && <div className="sidebar-backdrop" onClick={onClose} />}
      
      <div className={`sidebar sidebar--coffee ${isOpen ? 'open' : ''}`}>
        {/* Mobile close button */}
        <button className="sidebar-close-btn" onClick={onClose} aria-label="Close menu">
          ×
        </button>
        
        <div className="sidebar-header">
        <div className="sidebar-title-wrapper">
          <div className="sidebar-title">
            <MidnightLogo size={22} className="midnight-logo--sidebar" />
            <span className="sidebar-title-text">MidnightCoffee</span>
          </div>
        </div>
        {/* View-mode toggle sits in the header so its position is
            anchored independent of whatever the body of the sidebar
            is showing (sections / tabs / search). Hidden during
            search because search overrides the view-mode gates. */}
        {!searchQuery && (
          <button
            type="button"
            className="icon-button sidebar-view-mode-header-btn"
            onClick={() =>
              setViewModeAndPersist(viewMode === 'sections' ? 'tabs' : 'sections')
            }
            title={
              viewMode === 'sections'
                ? 'Switch to tabbed view (one section at a time)'
                : 'Switch to combined view (both sections visible)'
            }
            aria-label="Switch view mode"
          >
            {viewMode === 'sections' ? '⊟' : '☰'}
          </button>
        )}
        {/* Settings moved to the top-right auth chip (see App.jsx) so
            the sidebar header doesn't fight for space with two icon
            buttons. The view-mode toggle stays here because it's a
            sidebar-scoped control. */}
      </div>

      {/* Prominent New Discussion Button — enabled even when other
          conversations are streaming, up to the soft concurrent-stream cap. */}
      <div className="sidebar-actions">
        <button
          className="new-council-btn"
          onClick={onNewConversation}
          disabled={!canStartNewConversation}
          title={
            !canStartNewConversation
              ? `Limit: ${maxConcurrentStreams} concurrent essays`
              : 'Start a new essay (others keep running in the background)'
          }
        >
          <span className="btn-icon">+</span>
          <span className="btn-text">New Discussion</span>
        </button>
      </div>

      {/* Coffee greeting strip — small "Pour №N" chip that orients
          returning users without taking up real estate. Hidden while
          the user is actively searching to avoid noise. */}
      {!searchQuery && (
        <div className="sidebar-pour-strip" aria-hidden="true">
          <span className="sidebar-pour-strip-number">
            Pour №{(conversations?.length || 0) + 1}
          </span>
        </div>
      )}

      {/* Search Input */}
      <div className="sidebar-search">
        <input
          type="text"
          className="search-input"
          placeholder="Find a draft or past pour…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            className="search-clear"
            onClick={() => setSearchQuery('')}
            title="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* In tabs mode, the tab strip occupies its own row. In sections
          mode this row doesn't render at all (the view-mode toggle now
          lives in the sidebar header, so there's nothing else to put
          here). Hidden during search since search overrides view mode. */}
      {!searchQuery && viewMode === 'tabs' && (
        <div className="sidebar-view-toggle sidebar-view-toggle--tabs">
          <div className="sidebar-tabs" role="tablist" aria-label="Sidebar content">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'drafts'}
              className={
                'sidebar-tab ' +
                (activeTab === 'drafts' ? 'sidebar-tab--active' : '')
              }
              onClick={() => setActiveTabAndPersist('drafts')}
            >
              <span className="sidebar-tab-icon" aria-hidden="true">✏️</span>
              <span>Drafts</span>
              <span className="sidebar-tab-count">{inProgressSessions.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'essays'}
              className={
                'sidebar-tab ' +
                (activeTab === 'essays' ? 'sidebar-tab--active' : '')
              }
              onClick={() => setActiveTabAndPersist('essays')}
            >
              <span className="sidebar-tab-icon" aria-hidden="true">☕</span>
              <span>Essays</span>
              <span className="sidebar-tab-count">{conversations?.length || 0}</span>
            </button>
          </div>
        </div>
      )}

      {/* Drafts in progress — unfinished essay_sessions surfaced so
          users can pick up where they left off. Hidden when there's
          nothing to show (after filtering) and in tabs mode when the
          user has the Essays tab active. During an active search we
          show both filtered lists regardless of view mode — search is
          a meta mode that overrides the section/tab gates. */}
      {filteredDrafts.length > 0 &&
        (searchQuery || viewMode === 'sections' || activeTab === 'drafts') && (
        <div
          ref={draftsRef}
          className={
            'sidebar-drafts ' +
            (draftsExpanded ? '' : 'sidebar-drafts--collapsed ') +
            // When the drafts list is the only content visible (tabs
            // mode with the drafts tab active, no search), let it
            // absorb all remaining sidebar height instead of capping
            // at the sections-mode max-height.
            (viewMode === 'tabs' && !searchQuery ? 'sidebar-drafts--solo' : '')
          }
          style={
            draftsExpanded && draftsHeightPx != null && viewMode === 'sections'
              ? { height: draftsHeightPx, maxHeight: 'none' }
              : undefined
          }
        >
          {(viewMode === 'sections' || searchQuery) && (
            <button
              type="button"
              className="sidebar-drafts-header sidebar-drafts-header--toggle"
              onClick={toggleDraftsExpanded}
              aria-expanded={draftsExpanded}
              aria-controls="sidebar-drafts-list"
              title={draftsExpanded ? 'Hide drafts in progress' : 'Show drafts in progress'}
            >
              <span className="sidebar-drafts-header-chevron" aria-hidden="true">
                {draftsExpanded ? '▾' : '▸'}
              </span>
              <span>Drafts in progress</span>
              <span className="sidebar-drafts-header-count">{filteredDrafts.length}</span>
            </button>
          )}
          {(draftsExpanded || viewMode === 'tabs') && <div id="sidebar-drafts-list" className="sidebar-drafts-list">
          {filteredDrafts.map((s) => {
            const topicPreview = (s.topic || '').trim();
            const display =
              topicPreview.length > 56
                ? topicPreview.slice(0, 53) + '…'
                : topicPreview || 'Untitled draft';
            const stepLabel = STEP_LABELS_SHORT[s.step] || 'Step 1 · Topic';
            const updated = s.updated_at ? new Date(s.updated_at) : null;
            const updatedDisplay = updated && !Number.isNaN(updated.getTime())
              ? formatRelativeTime(updated)
              : '';
            const confirming = confirmingDeleteSession === s.id;
            const isActive = currentSessionId === s.id;
            return (
              <div
                key={s.id}
                className={`sidebar-draft-item ${isActive ? 'sidebar-draft-item--active' : ''}`}
                onClick={() => onResumeSession?.(s)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onResumeSession?.(s);
                  }
                }}
              >
                <div className="sidebar-draft-title" title={topicPreview}>
                  <span className="sidebar-item-icon" aria-hidden="true">✏️</span>
                  <span>{display}</span>
                </div>
                <div className="sidebar-draft-meta">
                  <span className="sidebar-draft-step">{stepLabel}</span>
                  {updatedDisplay && (
                    <span className="sidebar-draft-time">{updatedDisplay}</span>
                  )}
                  {confirming ? (
                    <div className="delete-confirm">
                      <button
                        className="confirm-yes-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession?.(s.id);
                          setConfirmingDeleteSession(null);
                        }}
                        title="Confirm delete"
                      >
                        ✓
                      </button>
                      <button
                        className="confirm-no-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDeleteSession(null);
                        }}
                        title="Cancel"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      className="delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingDeleteSession(s.id);
                      }}
                      title="Delete this draft"
                    >
                      🗑️
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          </div>}
        </div>
      )}

      {/* Draggable splitter between drafts and essays. Only meaningful
          in sections mode + when both sections will actually render
          (drafts has matches, essays section will show). The handle
          itself is a thin transparent strip; the hover/active state
          gives a clear gold cue without dominating the layout. */}
      {filteredDrafts.length > 0 &&
        draftsExpanded &&
        (viewMode === 'sections' || searchQuery) && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize drafts and essays sections"
            onPointerDown={handleResizeStart}
            title="Drag to resize"
          >
            <span className="sidebar-resizer-handle" aria-hidden="true" />
          </div>
        )}

      {/* Past essays — completed conversations. In sections mode, this
          gets its own collapsible header that mirrors "Drafts in
          progress" above. During search the header is hidden because
          the input itself is the section label. In tabs mode it only
          renders when the Essays tab is active. */}
      {(viewMode === 'sections' || activeTab === 'essays' || searchQuery) && (
        <div className={`sidebar-essays ${essaysExpanded ? '' : 'sidebar-essays--collapsed'}`}>
          {(viewMode === 'sections' || searchQuery) && (
            <button
              type="button"
              className="sidebar-essays-header sidebar-essays-header--toggle"
              onClick={toggleEssaysExpanded}
              aria-expanded={essaysExpanded}
              aria-controls="sidebar-essays-list"
              title={essaysExpanded ? 'Hide past essays' : 'Show past essays'}
            >
              <span className="sidebar-essays-header-chevron" aria-hidden="true">
                {essaysExpanded ? '▾' : '▸'}
              </span>
              <span>Past essays</span>
              <span className="sidebar-essays-header-count">
                {filteredConversations.length}
              </span>
            </button>
          )}
          {(essaysExpanded || searchQuery || viewMode === 'tabs') && (
          <div id="sidebar-essays-list" className="conversation-list">
            {filteredConversations.length === 0 ? (
              <div className="sidebar-empty-state">
                {searchQuery ? (
                  <>
                    <div className="sidebar-empty-state-title">No matches</div>
                    <div className="sidebar-empty-state-hint">
                      Nothing here for "{searchQuery}". Clear the search to see every essay.
                    </div>
                  </>
                ) : (
                  <div className="sidebar-empty-state-title">
                    Nothing brewing yet.
                  </div>
                )}
              </div>
            ) : (
              filteredConversations.map((conv) => {
                const streaming = isConversationStreaming(conv.id);
                const cleaned = cleanTitle(conv.title);
                const display = cleaned || (streaming ? 'Drafting…' : 'New Conversation');
                return (
                <div
                  key={conv.id}
                  className={`conversation-item ${conv.id === currentConversationId ? 'active' : ''} ${streaming ? 'streaming' : ''}`}
                  onClick={() => onSelectConversation(conv.id)}
                >
                  <div className="conversation-title">
                    {streaming && (
                      <span
                        className="conversation-streaming-dot"
                        title="Drafting in progress"
                        aria-label="Drafting in progress"
                      />
                    )}
                    <span className="sidebar-item-icon" aria-hidden="true">☕</span>
                    <span className="conversation-title-text">{display}</span>
                  </div>
                  <div className="conversation-meta">
                    <span>{new Date(conv.created_at).toLocaleDateString()}</span>
                    {isLoading && conv.id === currentConversationId ? (
                      <button className="stop-generation-btn small" onClick={handleAbortClick}>
                        Stop
                      </button>
                    ) : confirmingDelete === conv.id ? (
                      <div className="delete-confirm">
                        <button
                          className="confirm-yes-btn"
                          onClick={(e) => handleConfirmDelete(e, conv.id)}
                          title="Confirm delete"
                        >
                          ✓
                        </button>
                        <button
                          className="confirm-no-btn"
                          onClick={handleCancelDelete}
                          title="Cancel"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        className="delete-btn"
                        onClick={(e) => handleDeleteClick(e, conv.id)}
                        title="Delete conversation"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
                );
              })
            )}
          </div>
          )}
        </div>
      )}
    </div>
    </>
  );
}
