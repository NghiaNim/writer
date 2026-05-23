import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import EssayFlow from './components/EssayFlow';
import Settings from './components/Settings';
import Login from './components/Login';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { TunablesProvider } from './contexts/TunablesContext.jsx';
import { api, warmUpBackend } from './api';
import './App.css';
import './components/StageCopyButtons.css';

// Soft cap so a user can't fan out so many parallel streams that we hit
// rate limits on the chosen council models. ~3 concurrent essays gives
// "I started another one while the first finishes" headroom without
// blowing past OpenRouter's free-tier RPM. Easy to bump later.
const MAX_CONCURRENT_STREAMS = 3;

/**
 * Mirror of `heuristic_conversation_title` in backend/council.py so the
 * sidebar gets a clean title BEFORE the backend's Flash polish round-trips.
 * Strips a leading "TOPIC:" / "DRAFT:" prefix, drops everything after the
 * first newline (so AUDIENCE / KEY IDEA scaffolding doesn't leak into the
 * sidebar), trims to ≤60 chars. Keep these two implementations in sync.
 */
function deriveTitleFromMessage(content) {
  if (!content || typeof content !== 'string') return '';
  let s = content.trim();
  s = s.replace(/^(topic|draft)\s*:\s*/i, '');
  const firstLineBreak = s.indexOf('\n');
  if (firstLineBreak > 0) s = s.slice(0, firstLineBreak).trim();
  s = s.replace(/^['"]+|['"]+$/g, '').trim();
  if (!s) return '';
  if (s.length > 60) s = s.slice(0, 57).trimEnd() + '…';
  return s;
}

/** Matches backend council-config validation (≥2 enabled personas + models + chairman). */
function isUserCouncilReady(cc) {
  if (!cc?.personas || !(cc.chairman_model || '').trim()) return false;
  const enabled = cc.personas.filter((p) => p.enabled);
  if (enabled.length < 2) return false;
  return enabled.every((p) => (p.model || '').trim() !== '');
}

function councilGridModelsFromConfig(cc) {
  if (!cc?.personas) return [];
  return cc.personas
    .filter((p) => p.enabled && (p.model || '').trim())
    .map((p) => p.model);
}

async function syncCouncilFromUserConfig(setters) {
  const { setCouncilModels, setChairmanModel, setCouncilConfigured } = setters;
  try {
    const cc = await api.councilConfig.get();
    setCouncilModels(councilGridModelsFromConfig(cc));
    setChairmanModel(cc.chairman_model || null);
    setCouncilConfigured(isUserCouncilReady(cc));
  } catch (e) {
    console.error('Failed to load user council config:', e);
    // Avoid flashing "Council not ready" on transient errors — hosted app uses
    // Supabase rows, not legacy settings.json council_models.
  }
}

function AppShell() {
  const { user, logout } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [currentConversation, setCurrentConversation] = useState(null);
  // Set of conversation IDs that currently have an open SSE stream. Replaces
  // the prior single `isLoading` boolean so multiple essays can stream in
  // parallel — switching conversations no longer aborts the one you left.
  // `isLoading` (below) is derived from this set + the active conversation.
  const [streamingIds, setStreamingIds] = useState(() => new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState('council');
  const [ollamaStatus, setOllamaStatus] = useState({
    connected: false,
    lastConnected: null,
    testing: false
  });
  const [councilConfigured, setCouncilConfigured] = useState(true); // Assume configured until checked
  const [councilModels, setCouncilModels] = useState([]);
  const [chairmanModel, setChairmanModel] = useState(null);
  const [searchProvider, setSearchProvider] = useState('duckduckgo');
  const [essayMode, setEssayMode] = useState('topic'); // 'topic' | 'draft'
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Phase 3: EssayFlow gates new essay creation. We start with it visible
  // so a logged-in user lands directly on the topic prompt. essayFlowKey is
  // bumped each time we want a fresh, reset EssayFlow (e.g. starting another
  // essay after one completes).
  const [essayFlowVisible, setEssayFlowVisible] = useState(true);
  const [essayFlowKey, setEssayFlowKey] = useState(0);
  // Extension #1: current essay_sessions row id, threaded into send-message
  // so the backend can resolve per-essay word_target + council_config.
  // Stays in App state (not the conversation) since regenerate re-uses it.
  const [currentSessionId, setCurrentSessionId] = useState(null);
  // The council that's active for the in-flight (or just-finished) request.
  // Used to render CouncilChips while the council deliberates. Falls back to
  // the user's saved default if EssayFlow doesn't supply one.
  const [currentCouncil, setCurrentCouncil] = useState(null);
  const [currentWordTarget, setCurrentWordTarget] = useState(null);
  // Per-conversation AbortControllers so streams in different conversations
  // can run concurrently. handleAbort takes an optional convId; defaults to
  // the active conversation so existing single-stream UX still works.
  const abortControllersRef = useRef(new Map());

  // Per-conversation in-memory state cache. Lets SSE events for a stream
  // the user has navigated AWAY from continue to accumulate progress, so
  // when they switch back mid-stream they see live partial state instead
  // of either a stale snapshot or an empty server fetch. Keyed by
  // conversation id; values are the full conversation object (id, title,
  // messages[]). Pruned when streams complete + the conv is reloaded
  // from server.
  const liveConversationsRef = useRef(new Map());

  // Derived "is the active conversation streaming?" — keeps Sidebar's Stop
  // button + busy-disabled inputs working with the parallel model. The
  // sidebar's pulse dot uses the full set via the `streamingIds` prop.
  const isLoading = !!currentConversationId && streamingIds.has(currentConversationId);

  // Can the user start ANOTHER essay right now? True unless we're already
  // at the concurrency cap. Used by the Sidebar's "New Discussion" button
  // so users can fan out parallel runs.
  const canStartNewConversation = streamingIds.size < MAX_CONCURRENT_STREAMS;
  // After EssayFlow creates a conversation, GET /api/conversations/:id would
  // return messages:[] until the stream persists — that fetch would clobber
  // optimistic UI. Skip exactly one load for that id hand-off.
  const skipNextConversationFetchRef = useRef(false);
  // Shown when the post-intake stream fails so the user isn't dropped on an
  // empty hero with no explanation.
  const [streamHandoffError, setStreamHandoffError] = useState(null);

  // "Drafts in progress" — unfinished essay_sessions for the sidebar.
  // Loaded on mount + after every session create/update/delete so the
  // list stays roughly in sync without a websocket.
  const [inProgressSessions, setInProgressSessions] = useState([]);
  // The session passed to EssayFlow as initialSession on resume. Stays
  // null when starting a fresh essay — null = "blank form." The key
  // bump on essayFlowKey forces EssayFlow to remount when this changes.
  const [resumeSession, setResumeSession] = useState(null);

  // Load settings + conversations + in-progress drafts on mount
  useEffect(() => {
    checkInitialSetup();
    loadConversations();
    loadInProgressSessions();
  }, []);

  const checkInitialSetup = async () => {
    try {
      // Load execution mode + search preferences. API keys are managed
      // server-side via Render env vars (OPENROUTER_API_KEY), so we don't
      // prompt the user to configure them — that's a no-op in the hosted
      // product. We also don't auto-pop the settings panel anymore.
      const settings = await api.getSettings();
      setSearchProvider(settings.search_provider || 'duckduckgo');

      // Mark Ollama as not used in the hosted product (keeps the badge
      // off rather than perpetually "testing").
      setOllamaStatus({ connected: false, lastConnected: null, testing: false });

      await syncCouncilFromUserConfig({
        setCouncilModels,
        setChairmanModel,
        setCouncilConfigured,
      });
    } catch (error) {
      console.error('Failed to check initial setup:', error);
    }
  };

  // Re-check council configuration when settings close
  const handleSettingsClose = async () => {
    setShowSettings(false);
    try {
      const settings = await api.getSettings();
      setSearchProvider(settings.search_provider || 'duckduckgo');
      await syncCouncilFromUserConfig({
        setCouncilModels,
        setChairmanModel,
        setCouncilConfigured,
      });
    } catch (error) {
      console.error('Error after closing settings:', error);
    }
  };

  const handleOpenSettings = (section = 'council') => {
    setSettingsInitialSection(section || 'council');
    setShowSettings(true);
  };

  const testOllamaConnection = async (customUrl = null) => {
    try {
      setOllamaStatus(prev => ({ ...prev, testing: true }));

      // Use custom URL if provided, otherwise get from settings
      let urlToTest = customUrl;
      if (!urlToTest) {
        const settings = await api.getSettings();
        urlToTest = settings.ollama_base_url;
      }

      if (!urlToTest) {
        setOllamaStatus({ connected: false, lastConnected: null, testing: false });
        return;
      }

      const result = await api.testOllamaConnection(urlToTest);

      if (result.success) {
        setOllamaStatus({
          connected: true,
          lastConnected: new Date().toLocaleString(),
          testing: false
        });
      } else {
        setOllamaStatus({ connected: false, lastConnected: null, testing: false });
      }
    } catch (error) {
      console.error('Ollama connection test failed:', error);
      setOllamaStatus({ connected: false, lastConnected: null, testing: false });
    }
  };

  // Load conversation details when selected (skip one fetch after EssayFlow
  // creates a row — see skipNextConversationFetchRef).
  useEffect(() => {
    if (!currentConversationId) return;
    if (skipNextConversationFetchRef.current) {
      skipNextConversationFetchRef.current = false;
      return;
    }
    // If this conversation has a live stream + cached state, restore from
    // the in-memory cache so the user lands on whatever partial progress
    // has accumulated while they were looking elsewhere. The cache is
    // continuously updated by safeSetConv for every SSE event the stream
    // emits, so this is always at least as fresh as the server.
    if (streamingIds.has(currentConversationId)) {
      const cached = liveConversationsRef.current.get(currentConversationId);
      if (cached) {
        setCurrentConversation(cached);
        return;
      }
      // Streaming but no cache yet (rare race) — leave visible state alone
      // until the next safeSetConv tick fills the cache and the active-conv
      // branch of that setter syncs it to the view.
      return;
    }
    loadConversation(currentConversationId);
  }, [currentConversationId, streamingIds]);

  const loadConversations = async (retryCount = 0) => {
    try {
      const convs = await api.listConversations();
      setConversations(convs);
    } catch (error) {
      console.error('Failed to load conversations:', error);
      // Retry up to 3 times with increasing delays (1s, 2s, 3s)
      if (retryCount < 3) {
        setTimeout(() => loadConversations(retryCount + 1), (retryCount + 1) * 1000);
      }
    }
  };

  const loadInProgressSessions = async () => {
    try {
      const list = await api.sessions.list({ status: 'in_progress', limit: 20 });
      setInProgressSessions(Array.isArray(list) ? list : []);
    } catch (error) {
      console.warn('Failed to load in-progress sessions:', error);
      // Non-blocking — the sidebar just won't show the section.
    }
  };

  const handleResumeSession = async (sessionListItem) => {
    try {
      // Fetch the full session row (the list item has only metadata).
      const fullSession = await api.sessions.get(sessionListItem.id);
      setResumeSession(fullSession);
      setCurrentSessionId(fullSession.id);
      setCurrentConversationId(null);
      setEssayFlowVisible(true);
      setEssayFlowKey((k) => k + 1);
      setSidebarOpen(false);
    } catch (err) {
      console.error('Failed to resume session:', err);
    }
  };

  const handleDeleteSession = async (sessionId) => {
    try {
      await api.sessions.delete(sessionId);
      setInProgressSessions((prev) => prev.filter((s) => s.id !== sessionId));
      // If the user was actively viewing this session, drop them back
      // to a blank EssayFlow.
      if (currentSessionId === sessionId) {
        setResumeSession(null);
        setCurrentSessionId(null);
        setEssayFlowKey((k) => k + 1);
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  };

  const loadConversation = async (id) => {
    try {
      const conv = await api.getConversation(id);
      setCurrentConversation(conv);
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  };

  const handleNewConversation = async () => {
    // Phase 3: starting a new essay always opens the EssayFlow. The
    // conversation row is created on the backend AFTER EssayFlow's Step 3
    // completes. Bumping the key forces a fresh EssayFlow component (clears
    // any in-progress topic / so-what / draft state from a previous run).
    setStreamHandoffError(null);
    // Clear any resumed-draft seed so the fresh EssayFlow starts blank
    // instead of rehydrating from the previous draft.
    setResumeSession(null);
    setEssayFlowKey((k) => k + 1);
    setEssayFlowVisible(true);
    setCurrentConversationId(null);
    setCurrentConversation(null);
    setCurrentSessionId(null);
  };

  const handleSelectConversation = (id) => {
    // Selecting an existing conversation hides EssayFlow. We don't track the
    // session id for legacy conversations, so clear it — regenerate will
    // fall back to the user's default council config.
    setEssayFlowVisible(false);
    setCurrentConversationId(id);
    setCurrentSessionId(null);
  };

  const handleDeleteConversation = async (id) => {
    try {
      await api.deleteConversation(id);
      setConversations(prev => prev.filter(c => c.id !== id));
      if (id === currentConversationId) {
        setCurrentConversationId(null);
        setCurrentConversation(null);
        // Pop back to EssayFlow so the user has somewhere to land.
        setEssayFlowKey((k) => k + 1);
        setEssayFlowVisible(true);
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  };

  /**
   * Phase 3 hand-off: EssayFlow has finished collecting topic + so-what +
   * mode-specific context. Create the conversation row, hide EssayFlow, and
   * pipe the formatted message through the existing send-message stream.
   * Phase 5 will replace this with a dedicated POST /council/run.
   */
  const handleEssayFlowComplete = async ({
    message,
    essayMode: chosenMode,
    sessionId,
    wordTarget,
    councilConfig,
  }) => {
    setStreamHandoffError(null);
    let newConv = null;
    try {
      newConv = await api.createConversation();
      // Prevent useEffect(loadConversation) from replacing optimistic messages
      // with the empty server file before the stream persists.
      skipNextConversationFetchRef.current = true;
      // Optimistic title: derive locally from the topic line so the sidebar
      // shows something meaningful from the very first moment instead of
      // "New Conversation" until the backend's Flash polish lands.
      const optimisticTitle = deriveTitleFromMessage(message) || 'Drafting…';
      setConversations((prev) => [
        {
          id: newConv.id,
          created_at: newConv.created_at,
          message_count: 0,
          title: optimisticTitle,
        },
        ...prev,
      ]);
      setCurrentConversationId(newConv.id);
      // Seed matches POST /api/conversations response shape so spreads are safe.
      setCurrentConversation({
        id: newConv.id,
        created_at: newConv.created_at,
        title: newConv.title || optimisticTitle,
        messages: [],
      });
      setEssayMode(chosenMode);
      setEssayFlowVisible(false);
      setSidebarOpen(false);

      // Resolve which council to display in the chips. EssayFlow may have
      // explicitly customized one for this essay; otherwise fetch the user's
      // saved default. Either way, we cache it locally so the chip row can
      // light up while stages run.
      let activeCouncil = councilConfig;
      if (!activeCouncil) {
        try {
          activeCouncil = await api.councilConfig.get();
        } catch (e) {
          activeCouncil = null;
        }
      }
      setCurrentCouncil(activeCouncil);
      setCurrentWordTarget(typeof wordTarget === 'number' ? wordTarget : null);

      if (sessionId) {
        try {
          await api.sessions.update(sessionId, {
            conversation_id: newConv.id,
          });
        } catch (e) {
          console.warn('Failed to link session to conversation:', e);
        }
      }

      await handleSendMessage(message, false, {
        essayMode: chosenMode,
        conversationId: newConv.id,
        sessionId,
        propagateError: true,
      });
    } catch (error) {
      console.error('Failed to start essay session:', error);
      if (newConv?.id) {
        setConversations((prev) => prev.filter((c) => c.id !== newConv.id));
        try {
          await api.deleteConversation(newConv.id);
        } catch {
          /* best-effort cleanup */
        }
      }
      const msg =
        error?.message ||
        'Could not start the council run. Check your connection and try again.';
      setStreamHandoffError(msg);
      // Let the user retry intake without starting from a broken empty chat.
      setEssayFlowKey((k) => k + 1);
      setEssayFlowVisible(true);
      setCurrentConversationId(null);
      setCurrentConversation(null);
      setCurrentSessionId(null);
    }
  };

  // Abort one specific conversation's stream. Defaults to the active one
  // so the existing single-Stop-button UX is preserved; callers that want
  // to stop a background stream can pass its conversation id.
  const handleAbort = (convId = currentConversationId) => {
    if (!convId) return;
    const controller = abortControllersRef.current.get(convId);
    if (controller) {
      controller.abort();
    }
    setStreamingIds((prev) => {
      if (!prev.has(convId)) return prev;
      const next = new Set(prev);
      next.delete(convId);
      return next;
    });
  };

  const handleSendMessage = async (content, webSearch, options = {}) => {
    // Phase 3: accept an explicit conversationId so EssayFlow can hand off
    // immediately after creating the conversation, without waiting for
    // currentConversationId to propagate through React state.
    const { propagateError = false, ...streamOptions } = options;
    const targetConversationId =
      streamOptions.conversationId || currentConversationId;
    if (!targetConversationId) return;
    const requestEssayMode = streamOptions.essayMode || essayMode;

    // Each conversation gets its own AbortController, scoped to this run.
    // We deliberately do NOT cancel any other conversation's in-flight
    // controller — that's what enables parallel streaming sessions.
    const controller = new AbortController();
    abortControllersRef.current.set(targetConversationId, controller);

    setStreamingIds((prev) => {
      if (prev.has(targetConversationId)) return prev;
      const next = new Set(prev);
      next.add(targetConversationId);
      return next;
    });

    // Seed the in-memory cache from whatever the active view currently has
    // (when handleSendMessage is called for the freshly-created conv, this
    // is the seed object set by handleEssayFlowComplete; for a regenerate,
    // it's the existing currentConversation). The cache becomes the source
    // of truth for THIS stream so events still flow even if the user
    // navigates away mid-run.
    if (
      !liveConversationsRef.current.has(targetConversationId) &&
      currentConversation &&
      currentConversation.id === targetConversationId
    ) {
      liveConversationsRef.current.set(targetConversationId, currentConversation);
    }

    // Stream-local setter: applies the updater to THIS stream's target
    // conversation regardless of which conversation is currently visible,
    // by keeping the in-memory cache as the source of truth. Visible
    // state is then synced from the cache only when the active conv
    // matches the target — so background streams continue accumulating
    // progress in the cache while the user looks at a different
    // conversation, and switching back to a streaming conv shows live
    // partial state instead of stale or empty data.
    const safeSetConv = (updater) => {
      const apply = (target) => {
        if (!target) return target;
        return typeof updater === 'function' ? updater(target) : updater;
      };
      const cached = liveConversationsRef.current.get(targetConversationId);
      if (cached) {
        const next = apply(cached);
        if (next) liveConversationsRef.current.set(targetConversationId, next);
      }
      setCurrentConversation((prev) => {
        if (!prev || prev.id !== targetConversationId) return prev;
        const next = apply(prev);
        // Keep the cache aligned with the visible state if both branches
        // saw the update — guards against drift if React batches one
        // setter but not the other.
        if (next) liveConversationsRef.current.set(targetConversationId, next);
        return next;
      });
    };

    let streamError = null;
    try {
      // Optimistically add user message to UI
      const userMessage = { role: 'user', content };
      safeSetConv((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
      }));

      // Create a partial assistant message that will be updated progressively
      const assistantMessage = {
        role: 'assistant',
        stage1: null,
        stage2: null,
        stage3: null,
        metadata: null,
        loading: {
          search: false,
          stage1: false,
          stage2: false,
          stage3: false,
        },
        timers: {
          stage1Start: null,
          stage1End: null,
          stage2Start: null,
          stage2End: null,
          stage3Start: null,
          stage3End: null,
        },
        progress: {
          stage1: { count: 0, total: 0, currentModel: null },
          stage2: { count: 0, total: 0, currentModel: null }
        }
      };

      // Add the partial assistant message
      safeSetConv((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
      }));

      // Send message with streaming. `sessionId` (extension #1) lets the
      // backend pull word_target + council_config off the matching session.
      // We persist the active session id for regenerate to pick up too.
      const requestSessionId = streamOptions.sessionId || currentSessionId;
      if (streamOptions.sessionId) {
        setCurrentSessionId(streamOptions.sessionId);
      }
      await api.sendMessageStream(
        targetConversationId,
        {
          content,
          webSearch,
          essayMode: requestEssayMode,
          sessionId: requestSessionId,
        },
        (eventType, event) => {
          switch (eventType) {
            case 'search_start':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                const updatedLastMsg = {
                  ...lastMsg,
                  loading: {
                    ...lastMsg.loading,
                    search: true
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'search_complete':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                const updatedLastMsg = {
                  ...lastMsg,
                  loading: {
                    ...lastMsg.loading,
                    search: false
                  },
                  metadata: {
                    ...lastMsg.metadata,
                    search_query: event.data.search_query,
                    extracted_query: event.data.extracted_query,
                    search_context: event.data.search_context,
                    search_error: null,
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'search_error':
              // Search failed but the run continues — surface a warning so
              // the user knows the council is drafting without web context.
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                const updatedLastMsg = {
                  ...lastMsg,
                  loading: {
                    ...lastMsg.loading,
                    search: false
                  },
                  metadata: {
                    ...lastMsg.metadata,
                    search_query: event.data?.search_query,
                    search_error: {
                      provider: event.data?.provider,
                      message:
                        event.data?.message ||
                        'Web search failed; council ran without web context.',
                    },
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'pitch_start':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                const updatedLastMsg = {
                  ...lastMsg,
                  loading: { ...lastMsg.loading, pitch: true },
                  timers: { ...lastMsg.timers, pitchStart: Date.now() },
                };
                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'pitch_init':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                messages[messages.length - 1] = {
                  ...lastMsg,
                  progress: {
                    ...lastMsg.progress,
                    pitch: { count: 0, total: event.total },
                  },
                };
                return { ...prev, messages };
              });
              break;

            case 'pitch_progress':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                const updatedPitches = lastMsg.pitches
                  ? [...lastMsg.pitches, event.data]
                  : [event.data];
                messages[messages.length - 1] = {
                  ...lastMsg,
                  pitches: updatedPitches,
                  progress: {
                    ...lastMsg.progress,
                    pitch: { count: event.count, total: event.total },
                  },
                };
                return { ...prev, messages };
              });
              break;

            case 'pitch_complete':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                messages[messages.length - 1] = {
                  ...lastMsg,
                  pitches: event.data,
                  loading: { ...lastMsg.loading, pitch: false },
                  timers: { ...lastMsg.timers, pitchEnd: Date.now() },
                };
                return { ...prev, messages };
              });
              break;

            case 'pitch_picked':
              // event.data = {winner_index, reason, pitch}
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                messages[messages.length - 1] = {
                  ...lastMsg,
                  pickedPitch: event.data,
                };
                return { ...prev, messages };
              });
              break;

            case 'spine_picked':
              // event.data = {winner_index, reason, persona, model}
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                messages[messages.length - 1] = {
                  ...lastMsg,
                  pickedSpine: event.data,
                };
                return { ...prev, messages };
              });
              break;

            case 'stage1_start':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                const updatedLastMsg = {
                  ...lastMsg,
                  loading: {
                    ...lastMsg.loading,
                    stage1: true
                  },
                  timers: {
                    ...lastMsg.timers,
                    stage1Start: Date.now()
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'stage1_init':
              console.log('DEBUG: Received stage1_init', event);
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                const updatedLastMsg = {
                  ...lastMsg,
                  progress: {
                    ...lastMsg.progress,
                    stage1: {
                      count: 0,
                      total: event.total,
                      currentModel: null
                    }
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'stage1_progress':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                // Immutable update for stage1
                const updatedStage1 = lastMsg.stage1 ? [...lastMsg.stage1, event.data] : [event.data];
                const updatedLastMsg = {
                  ...lastMsg,
                  progress: {
                    ...lastMsg.progress,
                    stage1: {
                      count: event.count,
                      total: event.total,
                      currentModel: event.data.model
                    }
                  },
                  stage1: updatedStage1
                };

                messages[messages.length - 1] = updatedLastMsg;

                return { ...prev, messages };
              });
              break;

            case 'stage1_complete':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                // Immutable update to prevent React rendering issues
                const updatedLastMsg = {
                  ...lastMsg,
                  stage1: event.data,
                  loading: {
                    ...lastMsg.loading,
                    stage1: false
                  },
                  timers: {
                    ...lastMsg.timers,
                    stage1End: Date.now()
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'stage2_start':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                const updatedLastMsg = {
                  ...lastMsg,
                  loading: {
                    ...lastMsg.loading,
                    stage2: true
                  },
                  timers: {
                    ...lastMsg.timers,
                    stage2Start: Date.now()
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'stage2_init':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                const updatedLastMsg = {
                  ...lastMsg,
                  progress: {
                    ...lastMsg.progress,
                    stage2: {
                      count: 0,
                      total: event.total,
                      currentModel: null
                    }
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'stage2_progress':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                // Immutable update for stage2
                const updatedStage2 = lastMsg.stage2 ? [...lastMsg.stage2, event.data] : [event.data];
                const updatedLastMsg = {
                  ...lastMsg,
                  progress: {
                    ...lastMsg.progress,
                    stage2: {
                      count: event.count,
                      total: event.total,
                      currentModel: event.data.model
                    }
                  },
                  stage2: updatedStage2
                };

                messages[messages.length - 1] = updatedLastMsg;

                return { ...prev, messages };
              });
              break;

            case 'stage2_complete':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                // Immutable update to prevent React rendering issues
                const updatedLastMsg = {
                  ...lastMsg,
                  stage2: event.data,
                  loading: {
                    ...lastMsg.loading,
                    stage2: false
                  },
                  timers: {
                    ...lastMsg.timers,
                    stage2End: Date.now()
                  },
                  metadata: {
                    ...lastMsg.metadata,
                    ...event.metadata
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'stage3_start':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                const updatedLastMsg = {
                  ...lastMsg,
                  loading: {
                    ...lastMsg.loading,
                    stage3: true
                  },
                  timers: {
                    ...lastMsg.timers,
                    stage3Start: Date.now()
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'stage3_complete':
              safeSetConv((prev) => {
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];

                // Immutable update to prevent React rendering issues
                const updatedLastMsg = {
                  ...lastMsg,
                  stage3: event.data,
                  loading: {
                    ...lastMsg.loading,
                    stage3: false
                  },
                  timers: {
                    ...lastMsg.timers,
                    stage3End: Date.now()
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              // Hide loading indicator once final answer is shown — for THIS
              // conversation only. Other parallel streams stay marked
              // streaming in the sidebar.
              setStreamingIds((prev) => {
                if (!prev.has(targetConversationId)) return prev;
                const next = new Set(prev);
                next.delete(targetConversationId);
                return next;
              });
              break;

            case 'fact_check_start':
              // Mark the message as fact-checking so the UI can show a
              // small "running fact check…" affordance instead of
              // surfacing the panel with nothing in it.
              safeSetConv((prev) => {
                if (!prev) return prev;
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                if (!lastMsg || lastMsg.role !== 'assistant') return prev;
                messages[messages.length - 1] = {
                  ...lastMsg,
                  factCheckRunning: true,
                };
                return { ...prev, messages };
              });
              break;

            case 'fact_check_complete':
              safeSetConv((prev) => {
                if (!prev) return prev;
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                if (!lastMsg || lastMsg.role !== 'assistant') return prev;
                messages[messages.length - 1] = {
                  ...lastMsg,
                  factCheckRunning: false,
                  factCheckFlags: Array.isArray(event?.data?.flags)
                    ? event.data.flags
                    : [],
                };
                return { ...prev, messages };
              });
              break;

            case 'interim_question':
            case 'clarification_question':
              // The backend asks the user one more question while the
              // council is still working. clarification_question is the
              // chairman's final ask right before stage 3 — same data shape,
              // different label (chairmanAsk: true).
              safeSetConv((prev) => {
                if (!prev) return prev;
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                if (!lastMsg || lastMsg.role !== 'assistant') return prev;
                const existing = lastMsg.interimQuestions || [];
                if (existing.some((q) => q.question_id === event.data?.question_id)) {
                  return prev;
                }
                messages[messages.length - 1] = {
                  ...lastMsg,
                  interimQuestions: [
                    ...existing,
                    {
                      question_id: event.data.question_id,
                      question: event.data.question,
                      answer: '',
                      status: 'pending', // pending | submitted | skipped
                      chairmanAsk: eventType === 'clarification_question',
                    },
                  ],
                };
                return { ...prev, messages };
              });
              break;

            case 'title_complete': {
              // Patch the title in place — cheaper than a full reload and
              // avoids a sidebar flicker. The backend fires this as early
              // as it can (right after the pitch picker), so the sidebar
              // upgrades from the optimistic heuristic title to the
              // polished Flash title within ~5–8s of the user pressing Send.
              const newTitle = event?.data?.title || '';
              if (newTitle) {
                setConversations((prev) =>
                  prev.map((c) =>
                    c.id === targetConversationId ? { ...c, title: newTitle } : c
                  )
                );
                safeSetConv((prev) =>
                  prev && prev.id === targetConversationId
                    ? { ...prev, title: newTitle }
                    : prev
                );
              }
              break;
            }

            case 'run_finished':
              // Backend has fully terminated this run (success, error, or
              // shortly before either). Late interim-question answers will
              // still persist to user_fact but cannot land in this chairman
              // synthesis — freeze the panel.
              safeSetConv((prev) => {
                if (!prev) return prev;
                const messages = [...prev.messages];
                const lastMsg = messages[messages.length - 1];
                if (!lastMsg || lastMsg.role !== 'assistant') return prev;
                messages[messages.length - 1] = {
                  ...lastMsg,
                  runFinished: true,
                  runFinishedReason: event.reason || 'complete',
                };
                return { ...prev, messages };
              });
              break;

            case 'complete':
              setStreamingIds((prev) => {
                if (!prev.has(targetConversationId)) return prev;
                const next = new Set(prev);
                next.delete(targetConversationId);
                return next;
              });
              break;

            case 'error':
              console.error('Stream error:', event.message);
              streamError = new Error(
                event.message || 'The council run failed partway through.'
              );
              setStreamingIds((prev) => {
                if (!prev.has(targetConversationId)) return prev;
                const next = new Set(prev);
                next.delete(targetConversationId);
                return next;
              });
              break;

            default:
              console.log('Unknown event type:', eventType);
          }
        },
        controller.signal
      );
      if (streamError) {
        throw streamError;
      }
    } catch (error) {
      // Handle aborted requests - mark message as aborted
      if (error.name === 'AbortError') {
        console.log('Request aborted');
        // Mark the assistant message as aborted and stop timers
        safeSetConv((prev) => {
          if (!prev || prev.messages.length < 2) return prev;
          const messages = [...prev.messages];
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === 'assistant') {
            const now = Date.now();
            messages[messages.length - 1] = {
              ...lastMsg,
              aborted: true,
              runFinished: true,
              runFinishedReason: 'aborted',
              loading: {
                search: false,
                stage1: false,
                stage2: false,
                stage3: false,
              },
              timers: {
                ...lastMsg.timers,
                // Stop any running timers
                stage1End: lastMsg.timers?.stage1Start && !lastMsg.timers?.stage1End ? now : lastMsg.timers?.stage1End,
                stage2End: lastMsg.timers?.stage2Start && !lastMsg.timers?.stage2End ? now : lastMsg.timers?.stage2End,
                stage3End: lastMsg.timers?.stage3Start && !lastMsg.timers?.stage3End ? now : lastMsg.timers?.stage3End,
              }
            };
          }
          return { ...prev, messages };
        });
        return;
      }
      console.error('Failed to send message:', error);
      // Remove optimistic messages on error — only if the user is still
      // looking at this conversation. If they've navigated away, the
      // stream's error shouldn't yank visible state out from under them.
      safeSetConv((prev) => {
        if (!prev || prev.id !== targetConversationId) return prev;
        return { ...prev, messages: prev.messages.slice(0, -2) };
      });
      setStreamingIds((prev) => {
        if (!prev.has(targetConversationId)) return prev;
        const next = new Set(prev);
        next.delete(targetConversationId);
        return next;
      });
      if (propagateError) {
        throw error;
      }
    } finally {
      // Drop our controller from the map if it's still ours (a quick
      // sequence of sends to the SAME conv would have replaced it
      // already, in which case we leave the new one alone).
      if (abortControllersRef.current.get(targetConversationId) === controller) {
        abortControllersRef.current.delete(targetConversationId);
      }
      // Drop the live-cache entry now that the stream is done. The next
      // time the user navigates into this conversation, useEffect falls
      // through to loadConversation() and picks up the server-persisted
      // final state. Keeping the cache around past run-end risks showing
      // stale optimistic data after the backend has saved its version.
      liveConversationsRef.current.delete(targetConversationId);
      // Reload conversations to ensure title/messages are synced, even if aborted
      loadConversations();
      // The session has either just been completed (full essay) or
      // abandoned mid-stream — refresh in-progress drafts list too.
      loadInProgressSessions();
    }
  };

  // Submit (or skip) an answer to one of the interim questions the backend
  // emitted while drafting. Updates local message state immediately so the
  // panel feels snappy, then posts to /api/intake/answer in the background.
  // For non-empty answers, also fires /api/intake/expand to organize the
  // reply into bullets + entities + inferred + related-facts that get
  // rendered in the "what the council heard" panel.
  const handleAnswerInterim = async ({ questionId, question, answer, skipped }) => {
    if (!currentConversationId || !questionId) return;
    const trimmedAnswer = skipped ? '' : (answer || '').trim();
    const willExpand = !skipped && !!trimmedAnswer;

    setCurrentConversation((prev) => {
      if (!prev) return prev;
      const messages = [...prev.messages];
      const idx = messages.length - 1;
      const lastMsg = messages[idx];
      if (!lastMsg || lastMsg.role !== 'assistant') return prev;
      const updated = (lastMsg.interimQuestions || []).map((q) =>
        q.question_id === questionId
          ? {
              ...q,
              answer: trimmedAnswer,
              status: skipped ? 'skipped' : 'submitted',
              // Mark expansion-pending so the panel can show a "listening…"
              // shimmer instead of the verbatim echo while Flash works.
              expanding: willExpand,
              expansion: q.expansion || null,
            }
          : q
      );
      messages[idx] = { ...lastMsg, interimQuestions: updated };
      return { ...prev, messages };
    });
    try {
      await api.intake.answer({
        conversationId: currentConversationId,
        questionId,
        question,
        answer: trimmedAnswer,
        sessionId: currentSessionId,
        skipped: !!skipped,
      });
    } catch (e) {
      console.warn('Failed to record interim answer:', e);
    }

    if (!willExpand) return;

    // Fire-and-forget: organize the answer into structured bullets.
    // Latency is ~1.5–2s (one Gemini Flash call); the UI shows a
    // "listening…" state until it lands. Failure leaves expansion null
    // and the heard panel falls back to the raw answer.
    api.intake
      .expand({
        conversationId: currentConversationId,
        questionId,
        question,
        answer: trimmedAnswer,
      })
      .then((expansion) => {
        setCurrentConversation((prev) => {
          if (!prev) return prev;
          const messages = [...prev.messages];
          const idx = messages.length - 1;
          const lastMsg = messages[idx];
          if (!lastMsg || lastMsg.role !== 'assistant') return prev;
          const updated = (lastMsg.interimQuestions || []).map((q) =>
            q.question_id === questionId
              ? { ...q, expansion, expanding: false }
              : q
          );
          messages[idx] = { ...lastMsg, interimQuestions: updated };
          return { ...prev, messages };
        });
      })
      .catch((e) => {
        console.warn('Failed to expand interim answer:', e);
        setCurrentConversation((prev) => {
          if (!prev) return prev;
          const messages = [...prev.messages];
          const idx = messages.length - 1;
          const lastMsg = messages[idx];
          if (!lastMsg || lastMsg.role !== 'assistant') return prev;
          const updated = (lastMsg.interimQuestions || []).map((q) =>
            q.question_id === questionId ? { ...q, expanding: false } : q
          );
          messages[idx] = { ...lastMsg, interimQuestions: updated };
          return { ...prev, messages };
        });
      });
  };

  // Phase 3: regenerate the most recent essay using the same user prompt.
  // Sends a fresh request with identical content; the new attempt appears as
  // a new assistant message below the previous one in the same conversation.
  // Preserves the essay_mode (topic/draft) of the original attempt.
  const handleRegenerate = () => {
    if (!currentConversation || isLoading) return;
    const messages = currentConversation.messages || [];

    let lastUserContent = null;
    let lastAssistantEssayMode = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && !lastAssistantEssayMode) {
        lastAssistantEssayMode = m?.metadata?.essay_mode || null;
      }
      if (m.role === 'user' && typeof m.content === 'string') {
        lastUserContent = m.content;
        break;
      }
    }
    if (!lastUserContent) return;
    handleSendMessage(lastUserContent, false, {
      essayMode: lastAssistantEssayMode || essayMode,
      sessionId: currentSessionId,
    });
  };

  // Mobile sidebar handlers
  const handleMobileSelectConversation = (id) => {
    handleSelectConversation(id);
    setSidebarOpen(false); // Close sidebar on mobile after selection
  };

  const handleMobileNewConversation = async () => {
    await handleNewConversation();
    setSidebarOpen(false); // Close sidebar on mobile after creating new conversation
  };

  const handleMobileOpenSettings = () => {
    setSettingsInitialSection('council');
    setShowSettings(true);
    setSidebarOpen(false); // Close sidebar on mobile
  };

  return (
    <div className="app app--coffee">
      {/* Mobile hamburger menu button */}
      <button 
        className="mobile-menu-btn" 
        onClick={() => setSidebarOpen(true)}
        aria-label="Open menu"
      >
        <span className="hamburger-icon"></span>
      </button>

      {/* Phase 1: minimal auth chip in the top-right.
          Will be replaced by the full top nav in Phase 6. */}
      <div className="auth-chip" role="status" aria-label="Account">
        {user?.email && <span className="auth-chip-email">{user.email}</span>}
        <button
          type="button"
          className="auth-chip-logout"
          onClick={logout}
          title="Sign out"
        >
          Sign out
        </button>
      </div>

      <Sidebar
        conversations={conversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleMobileSelectConversation}
        onNewConversation={handleMobileNewConversation}
        onDeleteConversation={handleDeleteConversation}
        onOpenSettings={handleMobileOpenSettings}
        isLoading={isLoading}
        onAbort={handleAbort}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        streamingIds={streamingIds}
        canStartNewConversation={canStartNewConversation}
        maxConcurrentStreams={MAX_CONCURRENT_STREAMS}
        inProgressSessions={inProgressSessions}
        currentSessionId={currentSessionId}
        onResumeSession={handleResumeSession}
        onDeleteSession={handleDeleteSession}
      />
      {essayFlowVisible ? (
        <EssayFlow
          key={essayFlowKey}
          initialSession={resumeSession}
          onComplete={handleEssayFlowComplete}
          isBusy={isLoading}
          handoffError={streamHandoffError}
          onDismissHandoffError={() => setStreamHandoffError(null)}
          onOpenVoiceSettings={() => handleOpenSettings('voice')}
          onOpenPastEssay={handleSelectConversation}
          onSessionChanged={loadInProgressSessions}
        />
      ) : (
        <ChatInterface
          conversation={currentConversation}
          conversationId={currentConversationId}
          sessionId={currentSessionId}
          onSendMessage={handleSendMessage}
          onAbort={handleAbort}
          onRegenerate={handleRegenerate}
          onAnswerInterim={handleAnswerInterim}
          isLoading={isLoading}
          councilConfigured={councilConfigured}
          councilModels={councilModels}
          chairmanModel={chairmanModel}
          searchProvider={searchProvider}
          onOpenSettings={handleOpenSettings}
          essayMode={essayMode}
          onEssayModeChange={setEssayMode}
          activeCouncil={currentCouncil}
          activeWordTarget={currentWordTarget}
        />
      )}
      {showSettings && (
        <Settings
          onClose={handleSettingsClose}
          ollamaStatus={ollamaStatus}
          onRefreshOllama={testOllamaConnection}
          initialSection={settingsInitialSection}
        />
      )}
    </div>
  );
}

function AuthGate() {
  const { isAuthenticated, restoring } = useAuth();
  if (restoring) {
    // Wait for the stored session to be validated/refreshed before deciding
    // whether to show login. Otherwise we flash the login screen for one
    // paint on every page load with a saved session.
    return null;
  }
  if (!isAuthenticated) {
    return <Login />;
  }
  return <AppShell />;
}

function App() {
  // Fire a warm-up ping the moment the app loads so Render's cold start
  // happens in parallel with the login / topic-entry screens, not on the
  // user's first real submit.
  useEffect(() => {
    warmUpBackend();
  }, []);

  return (
    <AuthProvider>
      <TunablesProvider>
        <AuthGate />
      </TunablesProvider>
    </AuthProvider>
  );
}

export default App;