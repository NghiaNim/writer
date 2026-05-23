import React, { useState, useMemo } from 'react';
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
  // Collapsible "Drafts in progress" section. Persisted so the user's
  // choice survives reload — students with many completed essays
  // probably want drafts collapsed by default once they've scrolled
  // through them.
  const DRAFTS_EXPANDED_KEY = 'mc.sidebar.draftsExpanded';
  const [draftsExpanded, setDraftsExpanded] = useState(() => {
    try {
      const stored = window.localStorage.getItem(DRAFTS_EXPANDED_KEY);
      // Default expanded on first visit; collapsed only if the user
      // explicitly hid it last time.
      return stored == null ? true : stored === 'true';
    } catch {
      return true;
    }
  });
  const toggleDraftsExpanded = () => {
    setDraftsExpanded((cur) => {
      const next = !cur;
      try {
        window.localStorage.setItem(DRAFTS_EXPANDED_KEY, String(next));
      } catch {
        // localStorage disabled (private mode) — fine, just lose persistence.
      }
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
            <span className="coffee-bean sidebar-title-bean" aria-hidden="true" />
            {' '}MidnightCoffee
          </div>
        </div>
        <button
          className="icon-button"
          onClick={onOpenSettings}
          title="Settings"
        >
          ⚙️
        </button>
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
          placeholder="Find a past pour…"
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

      {/* Drafts in progress — unfinished essay_sessions surfaced so
          users can pick up where they left off. Hidden during search
          (different mental mode) and when there's nothing to show.
          The header is clickable to collapse the list, freeing screen
          real-estate for completed essays below. */}
      {!searchQuery && inProgressSessions.length > 0 && (
        <div className={`sidebar-drafts ${draftsExpanded ? '' : 'sidebar-drafts--collapsed'}`}>
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
            <span className="sidebar-drafts-header-count">{inProgressSessions.length}</span>
          </button>
          {draftsExpanded && <div id="sidebar-drafts-list" className="sidebar-drafts-list">
          {inProgressSessions.map((s) => {
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
                  {display}
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

      <div className="conversation-list">
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
    </div>
    </>
  );
}
