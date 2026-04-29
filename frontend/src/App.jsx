import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import EssayFlow from './components/EssayFlow';
import Settings from './components/Settings';
import Login from './components/Login';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { api, warmUpBackend } from './api';
import './App.css';
import './components/StageCopyButtons.css';

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
  const [isLoading, setIsLoading] = useState(false);
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
  const [executionMode, setExecutionMode] = useState('full');
  const [essayMode, setEssayMode] = useState('topic'); // Phase 4: 'topic' | 'draft'
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
  const abortControllerRef = useRef(null);
  const requestIdRef = useRef(0);
  const isInitialMount = useRef(true);
  // After EssayFlow creates a conversation, GET /api/conversations/:id would
  // return messages:[] until the stream persists — that fetch would clobber
  // optimistic UI. Skip exactly one load for that id hand-off.
  const skipNextConversationFetchRef = useRef(false);
  // Shown when the post-intake stream fails so the user isn't dropped on an
  // empty hero with no explanation.
  const [streamHandoffError, setStreamHandoffError] = useState(null);

  // Load settings + conversations on mount
  useEffect(() => {
    checkInitialSetup();
    loadConversations();
  }, []);

  const checkInitialSetup = async () => {
    try {
      // Load execution mode + search preferences. API keys are managed
      // server-side via Render env vars (OPENROUTER_API_KEY), so we don't
      // prompt the user to configure them — that's a no-op in the hosted
      // product. We also don't auto-pop the settings panel anymore.
      const settings = await api.getSettings();
      setExecutionMode(settings.execution_mode || 'full');
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

  // Auto-save execution mode preference when changed
  useEffect(() => {
    // Skip saving on initial mount
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    const saveExecutionMode = async () => {
      try {
        await api.updateSettings({ execution_mode: executionMode });
      } catch (error) {
        console.error('Failed to save execution mode:', error);
      }
    };

    saveExecutionMode();
  }, [executionMode]);

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
    loadConversation(currentConversationId);
  }, [currentConversationId]);

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
      setConversations(conversations.filter(c => c.id !== id));
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
      setConversations((prev) => [
        { id: newConv.id, created_at: newConv.created_at, message_count: 0 },
        ...prev,
      ]);
      setCurrentConversationId(newConv.id);
      // Seed matches POST /api/conversations response shape so spreads are safe.
      setCurrentConversation({
        id: newConv.id,
        created_at: newConv.created_at,
        title: newConv.title || 'New Conversation',
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

  const handleAbort = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      // Don't set to null here - let the request handler clean up
      // This prevents race conditions with rapid clicks
      setIsLoading(false);
    }
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

    // Assign unique ID to this request to prevent race conditions
    const currentRequestId = ++requestIdRef.current;

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();

    setIsLoading(true);
    let streamError = null;
    try {
      // Optimistically add user message to UI
      const userMessage = { role: 'user', content };
      setCurrentConversation((prev) => ({
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
      setCurrentConversation((prev) => ({
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
          executionMode,
          essayMode: requestEssayMode,
          sessionId: requestSessionId,
        },
        (eventType, event) => {
          switch (eventType) {
            case 'search_start':
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
                  }
                };

                messages[messages.length - 1] = updatedLastMsg;
                return { ...prev, messages };
              });
              break;

            case 'stage1_start':
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              setCurrentConversation((prev) => {
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
              // Hide loading indicator once final answer is shown
              setIsLoading(false);
              break;

            case 'title_complete':
              // Reload conversations to get updated title
              loadConversations();
              break;

            case 'complete':
              setIsLoading(false);
              break;

            case 'error':
              console.error('Stream error:', event.message);
              streamError = new Error(
                event.message || 'The council run failed partway through.'
              );
              setIsLoading(false);
              break;

            default:
              console.log('Unknown event type:', eventType);
          }
        },
        abortControllerRef.current?.signal
      );
      if (streamError) {
        throw streamError;
      }
    } catch (error) {
      // Handle aborted requests - mark message as aborted
      if (error.name === 'AbortError') {
        console.log('Request aborted');
        // Mark the assistant message as aborted and stop timers
        setCurrentConversation((prev) => {
          if (!prev || prev.messages.length < 2) return prev;
          const messages = [...prev.messages];
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === 'assistant') {
            const now = Date.now();
            messages[messages.length - 1] = {
              ...lastMsg,
              aborted: true,
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
      // Remove optimistic messages on error
      setCurrentConversation((prev) => ({
        ...prev,
        messages: prev.messages.slice(0, -2),
      }));
      setIsLoading(false);
      if (propagateError) {
        throw error;
      }
    } finally {
      // Only clear the controller if this is still the current request
      // This prevents race conditions if user rapidly sends multiple messages
      if (requestIdRef.current === currentRequestId) {
        abortControllerRef.current = null;
      }
      // Reload conversations to ensure title/messages are synced, even if aborted
      loadConversations();
    }
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
    <div className="app">
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
      />
      {essayFlowVisible ? (
        <EssayFlow
          key={essayFlowKey}
          onComplete={handleEssayFlowComplete}
          isBusy={isLoading}
          handoffError={streamHandoffError}
          onDismissHandoffError={() => setStreamHandoffError(null)}
          onOpenVoiceSettings={() => handleOpenSettings('voice')}
        />
      ) : (
        <ChatInterface
          conversation={currentConversation}
          conversationId={currentConversationId}
          sessionId={currentSessionId}
          onSendMessage={handleSendMessage}
          onAbort={handleAbort}
          onRegenerate={handleRegenerate}
          isLoading={isLoading}
          councilConfigured={councilConfigured}
          councilModels={councilModels}
          chairmanModel={chairmanModel}
          searchProvider={searchProvider}
          onOpenSettings={handleOpenSettings}
          executionMode={executionMode}
          onExecutionModeChange={setExecutionMode}
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
  const { isAuthenticated } = useAuth();
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
      <AuthGate />
    </AuthProvider>
  );
}

export default App;