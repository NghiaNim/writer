import React, { useState, useMemo } from 'react';
import { useTunable } from '../tunables';
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
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const coffee = useTunable('coffeeGreetingV1');

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
      
      <div className={`sidebar ${isOpen ? 'open' : ''} ${coffee ? 'sidebar--coffee' : ''}`}>
        {/* Mobile close button */}
        <button className="sidebar-close-btn" onClick={onClose} aria-label="Close menu">
          ×
        </button>
        
        <div className="sidebar-header">
        <div className="sidebar-title-wrapper">
          <div className="sidebar-title">
            {coffee ? (
              <span className="coffee-bean sidebar-title-bean" aria-hidden="true" />
            ) : (
              <span className="title-icon" aria-hidden="true">☕</span>
            )}
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

      {/* Coffee-themed greeting strip — small "Pour №N" chip that
          orients returning users without taking up real estate. Shown
          only when the coffee variant is on; quietly hides while the
          user is actively searching to avoid noise. */}
      {coffee && !searchQuery && (
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
          placeholder={coffee ? 'Find a past pour…' : 'Search conversations...'}
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
                {coffee ? 'Nothing brewing yet.' : 'No essays yet'}
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
