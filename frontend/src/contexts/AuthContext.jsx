import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setAuthTokenGetter, setUnauthorizedHandler } from '../api';

/**
 * AuthContext
 *
 * Holds the current Supabase session token and user, persisted to
 * localStorage so a page refresh keeps the user logged in. On mount we
 * validate the stored access token via /auth/me; if it's expired we try
 * /auth/refresh once before giving up.
 *
 * Wires the api helper so every fetch gets `Authorization: Bearer <token>`
 * automatically, and so any 401 on a protected endpoint logs the user out.
 */

const STORAGE_KEY = 'llm_council_session';

function readStoredSession() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            accessToken: parsed.accessToken || null,
            refreshToken: parsed.refreshToken || null,
            user: parsed.user || null,
        };
    } catch {
        return null;
    }
}

function writeStoredSession(session) {
    try {
        if (!session) {
            window.localStorage.removeItem(STORAGE_KEY);
        } else {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
        }
    } catch {
        // Best-effort. localStorage can be disabled (private mode, quota, etc.) —
        // session simply doesn't survive refresh in that case.
    }
}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [token, setToken] = useState(null);
    const [refreshToken, setRefreshToken] = useState(null);
    const [user, setUser] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    // `restoring` blocks initial render of protected UI until we've decided
    // whether the stored session is valid. Without this the app flashes the
    // login screen for one paint before /auth/me succeeds.
    const [restoring, setRestoring] = useState(true);

    // Refs so the closures we hand to api.js always read the latest values.
    const tokenRef = useRef(null);
    tokenRef.current = token;

    const persistSession = useCallback((accessToken, refresh, userObj) => {
        setToken(accessToken);
        setRefreshToken(refresh || null);
        setUser(userObj || null);
        tokenRef.current = accessToken;
        writeStoredSession({
            accessToken,
            refreshToken: refresh || null,
            user: userObj || null,
        });
    }, []);

    const clearSession = useCallback(() => {
        setToken(null);
        setRefreshToken(null);
        setUser(null);
        tokenRef.current = null;
        writeStoredSession(null);
    }, []);

    const login = useCallback(
        async (email, password) => {
            setLoading(true);
            setError(null);
            try {
                const result = await api.auth.login(email, password);
                if (!result.access_token) {
                    if (result.needs_email_confirmation) {
                        throw new Error(
                            'Check your email to confirm your account before logging in.'
                        );
                    }
                    const reason = result?.message || result?.error || JSON.stringify(result);
                    throw new Error(`Login failed: no access token returned. Server said: ${reason}`);
                }
                persistSession(result.access_token, result.refresh_token, result.user);
                return result;
            } catch (e) {
                setError(e.message || 'Login failed');
                throw e;
            } finally {
                setLoading(false);
            }
        },
        [persistSession]
    );

    const loginWithGoogleCode = useCallback(
        async (code, redirectTo) => {
            setLoading(true);
            setError(null);
            try {
                const result = await api.auth.exchangeGoogleCode(code, redirectTo);
                if (!result.access_token) {
                    throw new Error('Google sign-in failed: no access token returned.');
                }
                persistSession(result.access_token, result.refresh_token, result.user);
                return result;
            } catch (e) {
                setError(e.message || 'Google sign-in failed');
                throw e;
            } finally {
                setLoading(false);
            }
        },
        [persistSession]
    );

    const signup = useCallback(
        async (email, password) => {
            setLoading(true);
            setError(null);
            try {
                const result = await api.auth.signup(email, password);
                if (result.access_token) {
                    persistSession(result.access_token, result.refresh_token, result.user);
                }
                return result;
            } catch (e) {
                setError(e.message || 'Signup failed');
                throw e;
            } finally {
                setLoading(false);
            }
        },
        [persistSession]
    );

    const logout = useCallback(async () => {
        try {
            await api.auth.logout();
        } catch (_) {
            // ignore — local clear is what matters
        }
        clearSession();
    }, [clearSession]);

    // Restore session from localStorage on mount. Validate via /auth/me; if
    // expired, try refresh once. Either drops us into the app authenticated
    // or clears state and shows the login screen.
    useEffect(() => {
        let cancelled = false;
        const stored = readStoredSession();
        if (!stored || !stored.accessToken) {
            setRestoring(false);
            return;
        }

        // Seed state synchronously so the api token getter sees a token.
        setToken(stored.accessToken);
        setRefreshToken(stored.refreshToken);
        setUser(stored.user);
        tokenRef.current = stored.accessToken;

        (async () => {
            try {
                const me = await api.auth.me();
                if (cancelled) return;
                // Refresh user record in case it changed server-side.
                setUser(me);
                writeStoredSession({
                    accessToken: stored.accessToken,
                    refreshToken: stored.refreshToken,
                    user: me,
                });
            } catch {
                // /auth/me failed — try refresh if we have a refresh token.
                if (!stored.refreshToken) {
                    if (!cancelled) clearSession();
                    return;
                }
                try {
                    const refreshed = await api.auth.refresh(stored.refreshToken);
                    if (cancelled) return;
                    if (refreshed?.access_token) {
                        persistSession(
                            refreshed.access_token,
                            refreshed.refresh_token || stored.refreshToken,
                            refreshed.user || stored.user
                        );
                    } else {
                        clearSession();
                    }
                } catch {
                    if (!cancelled) clearSession();
                }
            } finally {
                if (!cancelled) setRestoring(false);
            }
        })();

        return () => {
            cancelled = true;
        };
        // Run exactly once on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Wire the api helper to read the current token and to call clearSession on 401.
    useEffect(() => {
        setAuthTokenGetter(() => tokenRef.current);
        setUnauthorizedHandler(() => {
            clearSession();
        });
    }, [clearSession]);

    const clearError = useCallback(() => setError(null), []);

    const value = useMemo(
        () => ({
            token,
            user,
            isAuthenticated: Boolean(token),
            loading,
            restoring,
            error,
            login,
            loginWithGoogleCode,
            signup,
            logout,
            clearError,
        }),
        [
            token,
            user,
            loading,
            restoring,
            error,
            login,
            loginWithGoogleCode,
            signup,
            logout,
            clearError,
        ]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) {
        throw new Error('useAuth must be used inside <AuthProvider>');
    }
    return ctx;
}
