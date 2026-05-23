/**
 * API client for the LLM Council backend.
 */

// Dynamically determine API base URL based on current hostname
// This allows the app to work on both localhost and network IPs
const getApiBase = () => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  const hostname = window.location.hostname;
  return `http://${hostname}:8001`;
};

export const API_BASE = getApiBase();

/**
 * Fire-and-forget warm-up ping. The hosted backend lives on Render's free
 * tier, which spins down after ~15 minutes of inactivity and takes 30-60s
 * to wake up. Calling this on app mount means the cold start runs in
 * parallel with the user reading the topic prompt instead of in series with
 * their first submit.
 *
 * Returns the latency in ms on success, or null on failure (we never throw).
 */
export async function warmUpBackend() {
  const started = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const res = await fetch(`${API_BASE}/healthz`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return Math.round(performance.now() - started);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth wiring (Phase 1)
//
// AuthContext registers a token getter and an unauthorized handler so this
// module never has to import React. `authedFetch` is a drop-in replacement
// for fetch that:
//   1. Adds `Authorization: Bearer <token>` when a token is present
//   2. On 401, clears the session via the registered handler
// Existing endpoints are NOT yet locked down server-side; this is in place
// for when later phases require auth on protected routes.
// ---------------------------------------------------------------------------

let _authTokenGetter = () => null;
let _onUnauthorized = () => {};

export function setAuthTokenGetter(fn) {
  _authTokenGetter = typeof fn === 'function' ? fn : () => null;
}

export function setUnauthorizedHandler(fn) {
  _onUnauthorized = typeof fn === 'function' ? fn : () => {};
}

async function authedFetch(input, init = {}) {
  const token = _authTokenGetter && _authTokenGetter();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  let response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (e) {
    // fetch() throws on network / CORS / DNS / TLS failures. Browser default
    // messages ("Failed to fetch", "Load failed") are useless, so attach
    // context so the user knows which host failed and why.
    const url = typeof input === 'string' ? input : input?.url || '';
    const reason = e?.message || 'Unknown network error';
    throw new Error(
      `Could not reach the server at ${url}. ${reason}. ` +
        `Render's free tier sleeps after ~15 minutes; first request can take 30-60s. ` +
        `If this persists, check that the backend is running and CORS allows this origin.`
    );
  }
  if (response.status === 401) {
    try {
      _onUnauthorized();
    } catch {
      // swallow — handler should never break the caller
    }
  }
  return response;
}

/**
 * Best-effort error message extractor for FastAPI/Render responses.
 * Falls back through:
 *   1. Parsed JSON `detail` (FastAPI standard error shape)
 *   2. Other JSON fields (`message`, `error`, full JSON)
 *   3. Raw body text (truncated)
 *   4. HTTP status line
 */
async function extractError(response, fallback) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const detail =
    parsed?.detail ||
    parsed?.message ||
    parsed?.error ||
    (parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : null);
  if (detail) return `${fallback}: ${detail} (HTTP ${response.status})`;
  if (body) {
    const trimmed = body.trim().slice(0, 240);
    return `${fallback}: ${trimmed} (HTTP ${response.status})`;
  }
  return `${fallback}: HTTP ${response.status} ${response.statusText || ''}`.trim();
}

export const api = {
  /**
   * Auth endpoints (Phase 1 — Supabase).
   */
  auth: {
    async getGoogleLoginUrl(redirectTo) {
      const response = await authedFetch(
        `${API_BASE}/auth/google/start?redirect_to=${encodeURIComponent(redirectTo)}`
      );
      if (!response.ok) {
        throw new Error(await extractError(response, 'Could not start Google sign-in'));
      }
      return response.json();
    },

    async exchangeGoogleCode(code, redirectTo) {
      const response = await authedFetch(`${API_BASE}/auth/google/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirect_to: redirectTo }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Google sign-in failed'));
      }
      return response.json();
    },

    async signup(email, password) {
      const response = await authedFetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Signup failed'));
      }
      return response.json();
    },

    async login(email, password) {
      const response = await authedFetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Login failed'));
      }
      return response.json();
    },

    async logout() {
      // Uses authedFetch so the current bearer token is included.
      const response = await authedFetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
      });
      if (!response.ok && response.status !== 401) {
        // 401 on logout is fine — token was already invalid.
        throw new Error('Logout failed');
      }
      return { ok: true };
    },

    async me() {
      const response = await authedFetch(`${API_BASE}/auth/me`);
      if (!response.ok) {
        throw new Error('Not authenticated');
      }
      return response.json();
    },

    async refresh(refreshToken) {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!response.ok) {
        throw new Error('Refresh failed');
      }
      return response.json();
    },
  },

  /**
   * Essay sessions (Phase 3 — auth-required).
   */
  sessions: {
    /**
     * Step 1: create a session with the topic. Returns the created row.
     * Accepts optional word_target (50-5000) for the new word-limit picker.
     */
    async create(topic, essayType = 'general', wordTarget = null) {
      const body = { topic, essay_type: essayType };
      if (typeof wordTarget === 'number' && wordTarget > 0) {
        body.word_target = wordTarget;
      }
      const response = await authedFetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || 'Failed to create session');
      }
      return response.json();
    },

    /** Read a session (must belong to the caller). */
    async get(sessionId) {
      const response = await authedFetch(`${API_BASE}/sessions/${sessionId}`);
      if (!response.ok) {
        throw new Error('Failed to load session');
      }
      return response.json();
    },

    /**
     * Step 2 / Step 3: partial update.
     * Patch object accepts: so_what_answer, path ('interactive'|'draft'),
     * conversation, draft, status, essay_type, topic.
     */
    async update(sessionId, patch) {
      const response = await authedFetch(`${API_BASE}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || 'Failed to update session');
      }
      return response.json();
    },

    /**
     * Non-blocking "have I written about this before?" check.
     * Returns { found, matches } where matches is at most 5 items.
     */
    async memoryCheck(topic) {
      const response = await authedFetch(
        `${API_BASE}/sessions/memory-check?topic=${encodeURIComponent(topic)}`
      );
      if (!response.ok) {
        return { found: false, matches: [] };
      }
      return response.json();
    },

    /**
     * List the caller's recent essay sessions (default: in-progress).
     * Powers the sidebar's "Drafts in progress" section.
     */
    async list({ status = 'in_progress', limit = 20 } = {}) {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      params.set('limit', String(limit));
      const response = await authedFetch(`${API_BASE}/sessions?${params.toString()}`);
      if (!response.ok) return [];
      return response.json();
    },

    /** Delete an essay session the caller owns. */
    async delete(sessionId) {
      const response = await authedFetch(`${API_BASE}/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || 'Failed to delete session');
      }
      return response.json();
    },
  },

  /**
   * Per-user default council configuration (extension #1).
   * Shape of payload:
   *   {
   *     personas: [{ key, enabled, model }, ...],
   *     chairman_model: string
   *   }
   */
  councilConfig: {
    async get() {
      const response = await authedFetch(`${API_BASE}/council-config`);
      if (!response.ok) {
        throw new Error('Failed to load council config');
      }
      return response.json();
    },
    async save(config) {
      const response = await authedFetch(`${API_BASE}/council-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || 'Failed to save council config');
      }
      return response.json();
    },
  },

  /**
   * Full OpenRouter model catalog used by the council picker.
   * Returns { models: [{ id, name, provider, context_length, is_free }] }.
   */
  models: {
    async list() {
      const response = await authedFetch(`${API_BASE}/api/models`);
      if (!response.ok) {
        return { models: [] };
      }
      return response.json();
    },
  },
  /**
   * List all conversations.
   */
  async listConversations() {
    const response = await authedFetch(`${API_BASE}/api/conversations`);
    if (!response.ok) {
      throw new Error('Failed to list conversations');
    }
    return response.json();
  },

  /**
   * Create a new conversation.
   */
  async createConversation() {
    const response = await authedFetch(`${API_BASE}/api/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error('Failed to create conversation');
    }
    return response.json();
  },

  /**
   * Get a specific conversation.
   */
  async getConversation(conversationId) {
    const response = await authedFetch(
      `${API_BASE}/api/conversations/${conversationId}`
    );
    if (!response.ok) {
      throw new Error('Failed to get conversation');
    }
    return response.json();
  },

  /**
   * Delete a conversation.
   */
  async deleteConversation(conversationId) {
    const response = await authedFetch(
      `${API_BASE}/api/conversations/${conversationId}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      throw new Error('Failed to delete conversation');
    }
    return response.json();
  },

  /**
   * Send a message in a conversation.
   */
  async sendMessage(conversationId, content, webSearch = false) {
    const response = await authedFetch(
      `${API_BASE}/api/conversations/${conversationId}/message`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, web_search: webSearch }),
      }
    );
    if (!response.ok) {
      throw new Error('Failed to send message');
    }
    return response.json();
  },

  /**
   * Get application settings.
   */
  async getSettings() {
    const response = await authedFetch(`${API_BASE}/api/settings`);
    if (!response.ok) {
      throw new Error('Failed to get settings');
    }
    return response.json();
  },

  /**
   * Test Tavily API key.
   */
  async testTavilyKey(apiKey) {
    const response = await authedFetch(`${API_BASE}/api/settings/test-tavily`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) {
      throw new Error('Failed to test API key');
    }
    return response.json();
  },

  /**
   * Test OpenRouter API key.
   */
  async testOpenRouterKey(apiKey) {
    const response = await authedFetch(`${API_BASE}/api/settings/test-openrouter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) {
      throw new Error('Failed to test API key');
    }
    return response.json();
  },

  /**
   * Test Brave API key.
   */
  async testBraveKey(apiKey) {
    const response = await authedFetch(`${API_BASE}/api/settings/test-brave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) {
      throw new Error('Failed to test API key');
    }
    return response.json();
  },

  /**
   * Test Serper API key.
   */
  async testSerperKey(apiKey) {
    const response = await authedFetch(`${API_BASE}/api/settings/test-serper`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) {
      throw new Error('Failed to test API key');
    }
    return response.json();
  },

  /**
   * Test a specific provider's API key.
   */
  async testProviderKey(providerId, apiKey) {
    const response = await authedFetch(`${API_BASE}/api/settings/test-provider`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider_id: providerId, api_key: apiKey }),
    });
    if (!response.ok) {
      throw new Error('Failed to test API key');
    }
    return response.json();
  },

  /**
   * Test Ollama connection.
   */
  async testOllamaConnection(baseUrl) {
    const response = await authedFetch(`${API_BASE}/api/settings/test-ollama`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base_url: baseUrl }),
    });
    if (!response.ok) {
      throw new Error('Failed to test Ollama connection');
    }
    return response.json();
  },

  /**
   * Test custom OpenAI-compatible endpoint.
   */
  async testCustomEndpoint(name, url, apiKey) {
    const response = await authedFetch(`${API_BASE}/api/settings/test-custom-endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, url, api_key: apiKey }),
    });
    if (!response.ok) {
      throw new Error('Failed to test custom endpoint');
    }
    return response.json();
  },

  /**
   * Get available models from custom endpoint.
   */
  async getCustomEndpointModels() {
    const response = await authedFetch(`${API_BASE}/api/custom-endpoint/models`);
    if (!response.ok) {
      throw new Error('Failed to get custom endpoint models');
    }
    return response.json();
  },

  /**
   * Get available models from OpenRouter.
   */
  async getModels() {
    const response = await authedFetch(`${API_BASE}/api/models`);
    if (!response.ok) {
      throw new Error('Failed to get models');
    }
    return response.json();
  },

  /**
   * Get available models from Ollama.
   */
  async getOllamaModels(baseUrl) {
    let url = `${API_BASE}/api/ollama/tags`;
    if (baseUrl) {
      url += `?base_url=${encodeURIComponent(baseUrl)}`;
    }
    const response = await authedFetch(url);
    if (!response.ok) {
      throw new Error('Failed to get Ollama models');
    }
    return response.json();
  },

  /**
   * Get available models from direct providers.
   */
  async getDirectModels() {
    const response = await authedFetch(`${API_BASE}/api/models/direct`);
    if (!response.ok) {
      throw new Error('Failed to get direct models');
    }
    return response.json();
  },

  /**
   * Get default model settings.
   */
  async getDefaultSettings() {
    const response = await authedFetch(`${API_BASE}/api/settings/defaults`);
    if (!response.ok) {
      throw new Error('Failed to get default settings');
    }
    return response.json();
  },

  /**
   * Voice profile (per-user, Supabase-backed).
   * Shape: {
   *   rules: string[],
   *   reference_paragraphs: string[],
   *   inferred_style: string,
   *   preferred_authors: string[],
   *   pending_suggestions: [{ id, rule, source, created_at }]
   * }
   *
   * Save body only accepts user-editable fields:
   *   { rules?, reference_paragraphs?, inferred_style?, preferred_authors? }
   * The pending_suggestions queue is owned by suggestRules / accept / reject.
   */
  // Tunables (feature flags). The set of valid keys lives in
  // frontend/src/tunables.js. The backend stores opaque JSON.
  tunables: {
    async get() {
      const response = await authedFetch(`${API_BASE}/api/tunables`);
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to load tunables'));
      }
      return response.json();
    },
    /**
     * Merge a patch into the user's tunables blob. Pass `null` as a value
     * to clear that key (so it falls back to the registry default).
     *   api.tunables.update({ sidebarV2: true })
     *   api.tunables.update({ sidebarV2: null })  // clear override
     */
    async update(patch, { replace = false } = {}) {
      const response = await authedFetch(`${API_BASE}/api/tunables`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch, replace }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to update tunables'));
      }
      return response.json();
    },
  },

  voice: {
    async get(essayType = 'general') {
      const url = `${API_BASE}/api/voice-profile?essay_type=${encodeURIComponent(essayType)}`;
      const response = await authedFetch(url);
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to load voice profile'));
      }
      return response.json();
    },
    async save(body, essayType = 'general') {
      const url = `${API_BASE}/api/voice-profile?essay_type=${encodeURIComponent(essayType)}`;
      const response = await authedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to save voice profile'));
      }
      return response.json();
    },
    async defaults() {
      const response = await authedFetch(`${API_BASE}/api/voice-profile/defaults`);
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to load default rules'));
      }
      return response.json();
    },
    async suggestRules({ source = 'reference_paragraphs', text = null, essayType = 'general' } = {}) {
      const response = await authedFetch(`${API_BASE}/api/voice-profile/suggest-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, text, essay_type: essayType }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to extract rule suggestions'));
      }
      return response.json();
    },
    async acceptSuggestion(suggestionId, essayType = 'general') {
      const response = await authedFetch(`${API_BASE}/api/voice-profile/accept-suggestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestion_id: suggestionId, essay_type: essayType }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to accept suggestion'));
      }
      return response.json();
    },
    async rejectSuggestion(suggestionId, essayType = 'general') {
      const response = await authedFetch(`${API_BASE}/api/voice-profile/reject-suggestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestion_id: suggestionId, essay_type: essayType }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to reject suggestion'));
      }
      return response.json();
    },
    /**
     * Distill a refinement instruction into a durable rule and stage it
     * in pending_suggestions. Returns:
     *   { proposed: bool, rule: string | null, profile: VoiceProfile }
     * `proposed=false` means the instruction was too one-off — UI should
     * silently skip the prompt.
     */
    async proposeRuleFromRefinement(instruction, essayType = 'general') {
      const response = await authedFetch(
        `${API_BASE}/api/voice-profile/propose-rule-from-refinement`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instruction,
            essay_type: essayType,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to propose rule'));
      }
      return response.json();
    },
  },

  essayMemory: {
    async submitFeedback(conversationId, { rating = null, feedbackText = '' } = {}) {
      const response = await authedFetch(`${API_BASE}/api/essay-memory/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          rating: rating ?? null,
          feedback_text: feedbackText || null,
        }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Could not save feedback'));
      }
      return response.json();
    },
  },

  userFacts: {
    async list() {
      const response = await authedFetch(`${API_BASE}/api/user-facts`);
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to load facts'));
      }
      return response.json();
    },
    async create(factText, source = 'manual') {
      const response = await authedFetch(`${API_BASE}/api/user-facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact_text: factText, source }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to save fact'));
      }
      return response.json();
    },
    async delete(factId) {
      const response = await authedFetch(`${API_BASE}/api/user-facts/${encodeURIComponent(factId)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to delete fact'));
      }
      return response.json();
    },
  },

  /**
   * Smart intake helpers (single-LLM-call, no council).
   *   POST /api/intake/questions   → { questions: string[] }
   *   POST /api/intake/example     → { example: string }
   *   POST /api/intake/core-idea   → { core_idea: string }
   */
  intake: {
    async questions({ topic, audience = '', essayType = 'general' }) {
      const response = await authedFetch(`${API_BASE}/api/intake/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, audience, essay_type: essayType }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to generate questions'));
      }
      return response.json();
    },
    /**
     * Stream tailored intake questions one at a time.
     *
     * Calls POST /api/intake/questions/stream and reads SSE events. The
     * server emits one `sections` event followed by one `question` event
     * per question, then a terminal `complete`.
     *
     * Returns `{ promise, abort }`. `abort()` cancels the underlying
     * fetch so the caller can bail if the user navigates away.
     */
    streamQuestions({ topic, audience = '', essayType = 'general', onSections, onQuestion, onError }) {
      const controller = new AbortController();
      const promise = (async () => {
        let response;
        try {
          response = await authedFetch(`${API_BASE}/api/intake/questions/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify({ topic, audience, essay_type: essayType }),
            signal: controller.signal,
          });
        } catch (err) {
          if (err?.name === 'AbortError') return { aborted: true };
          throw err;
        }
        if (!response.ok) {
          const detail = await extractError(response, 'Failed to stream questions');
          if (onError) onError(detail);
          throw new Error(detail);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sepIdx;
            while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
              const rawEvent = buffer.slice(0, sepIdx);
              buffer = buffer.slice(sepIdx + 2);
              let eventName = 'message';
              const dataLines = [];
              for (const line of rawEvent.split('\n')) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (dataLines.length === 0) continue;
              let payload = null;
              try {
                payload = JSON.parse(dataLines.join('\n'));
              } catch {
                payload = null;
              }
              if (eventName === 'sections' && payload?.sections && onSections) {
                onSections(payload.sections);
              } else if (eventName === 'question' && payload?.question && onQuestion) {
                onQuestion(payload.question, payload.index);
              } else if (eventName === 'error' && onError) {
                onError(payload?.message || 'Stream error');
              } else if (eventName === 'complete') {
                return { aborted: false, count: payload?.count || 0 };
              }
            }
          }
        } catch (err) {
          if (err?.name === 'AbortError') return { aborted: true };
          if (onError) onError(err?.message || 'Stream interrupted');
          throw err;
        }
        return { aborted: false };
      })();
      return { promise, abort: () => controller.abort() };
    },
    async brainstormTopics({ reflections }) {
      const response = await authedFetch(`${API_BASE}/api/intake/brainstorm-topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reflections }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to brainstorm topics'));
      }
      return response.json();
    },
    async regenerateQuestion({ topic, audience = '', essayType = 'general', alreadyAsked = [], rejectedQuestion = null }) {
      const response = await authedFetch(`${API_BASE}/api/intake/regenerate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          audience,
          essay_type: essayType,
          already_asked: alreadyAsked,
          rejected_question: rejectedQuestion,
        }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to swap question'));
      }
      return response.json();
    },
    async followUp({ topic, audience = '', essayType = 'general', question, answer, alreadyAsked = [] }) {
      const response = await authedFetch(`${API_BASE}/api/intake/follow-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          audience,
          essay_type: essayType,
          question,
          answer,
          already_asked: alreadyAsked,
        }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to load follow-up'));
      }
      return response.json();
    },
    async example({ topic, audience = '', question }) {
      const response = await authedFetch(`${API_BASE}/api/intake/example`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, audience, question }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to generate example'));
      }
      return response.json();
    },
    async answer({ conversationId, questionId, question, answer = '', sessionId = null, skipped = false }) {
      const response = await authedFetch(`${API_BASE}/api/intake/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          question_id: questionId,
          question,
          answer,
          session_id: sessionId,
          skipped,
        }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to record answer'));
      }
      return response.json();
    },
    async expand({ conversationId, questionId, question, answer = '' }) {
      const response = await authedFetch(`${API_BASE}/api/intake/expand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          question_id: questionId,
          question,
          answer,
        }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to expand answer'));
      }
      return response.json();
    },
    async coreIdea({ topic, audience = '', qa = [], essayType = 'general', sessionId = null }) {
      const response = await authedFetch(`${API_BASE}/api/intake/core-idea`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          audience,
          qa,
          essay_type: essayType,
          session_id: sessionId,
        }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to draft core idea'));
      }
      return response.json();
    },
  },

  /**
   * Essay-specific refinement chip ideas (single LLM call, auth-required).
   */
  refinement: {
    async suggestions({ essayText, originalBrief = '' }) {
      const response = await authedFetch(`${API_BASE}/api/refinement-suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          essay_text: essayText,
          original_brief: originalBrief,
        }),
      });
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to generate suggestions'));
      }
      return response.json();
    },
  },

  // Backwards-compatible thin wrappers for the legacy code paths that still
  // call `api.getVoiceProfile()` directly. Will be deleted once /voice page
  // migration in App.jsx is finished.
  async getVoiceProfile() {
    return this.voice.get();
  },
  async saveVoiceProfile(profile) {
    return this.voice.save(profile);
  },

  /**
   * Update application settings.
   */
  async updateSettings(settings) {
    const response = await authedFetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(settings),
    });
    if (!response.ok) {
      throw new Error('Failed to update settings');
    }
    return response.json();
  },

  /**
   * Send a message and receive streaming updates.
   * @param {string} conversationId - The conversation ID
   * @param {Object} options - Message options
   * @param {string} options.content - The message content
   * @param {boolean} options.webSearch - Whether to use web search
   * @param {string} options.essayMode - 'topic' (write from scratch) or 'draft' (refine the user's draft)
   * @param {string} options.sessionId - Optional essay_sessions row id
   * @param {function} onEvent - Callback function for each event: (eventType, data) => void
   * @param {AbortSignal} signal - Optional AbortSignal to cancel the request
   * @returns {Promise<void>}
   */
  async sendMessageStream(conversationId, options, onEvent, signal) {
    const {
      content,
      webSearch = false,
      essayMode = 'topic',
      sessionId = null,
    } = options;
    const body = {
      content,
      web_search: webSearch,
      essay_mode: essayMode,
    };
    if (sessionId) {
      body.session_id = sessionId;
    }
    const response = await authedFetch(
      `${API_BASE}/api/conversations/${conversationId}/message/stream?_t=${Date.now()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
        body: JSON.stringify(body),
        signal,
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      throw new Error('Failed to send message');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Buffer incomplete lines across chunk boundaries so large JSON payloads
    // (e.g. stage1_complete with all responses) are never silently dropped.
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep the potentially incomplete trailing line

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              onEvent(event.type, event);
            } catch (e) {
              console.error('Failed to parse SSE event:', e);
            }
          }
        }
      }
      // Flush any remaining complete event in the buffer
      if (buffer.startsWith('data: ')) {
        try {
          const event = JSON.parse(buffer.slice(6));
          onEvent(event.type, event);
        } catch (e) {
          console.error('Failed to parse SSE event (buffer flush):', e);
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};
