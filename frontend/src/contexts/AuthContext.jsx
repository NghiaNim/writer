import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setAuthTokenGetter, setUnauthorizedHandler } from '../api';

/**
 * AuthContext (Phase 1)
 *
 * Holds the current Supabase session token and user in **memory only**
 * (not localStorage). On page refresh the session is gone and the user
 * is bounced back to the login screen — this is intentional.
 *
 * Wires the api helper so every fetch gets `Authorization: Bearer <token>`
 * automatically, and so any 401 response logs the user out.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [token, setToken] = useState(null);
    const [user, setUser] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);

    // Use a ref so the token getter we hand to api.js always reads the
    // latest value, even though the closure was registered once at mount.
    const tokenRef = useRef(null);
    tokenRef.current = token;

    const clearSession = useCallback(() => {
        setToken(null);
        setUser(null);
        tokenRef.current = null;
    }, []);

    const login = useCallback(async (email, password) => {
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
                // Surface whatever the server actually returned so the user
                // can see why no token came back (e.g. unexpected response shape).
                const reason =
                    result?.message ||
                    result?.error ||
                    JSON.stringify(result);
                throw new Error(`Login failed: no access token returned. Server said: ${reason}`);
            }
            setToken(result.access_token);
            setUser(result.user);
            return result;
        } catch (e) {
            setError(e.message || 'Login failed');
            throw e;
        } finally {
            setLoading(false);
        }
    }, []);

    const signup = useCallback(async (email, password) => {
        setLoading(true);
        setError(null);
        try {
            const result = await api.auth.signup(email, password);
            // If email confirmation is on, server returns access_token = null.
            if (result.access_token) {
                setToken(result.access_token);
                setUser(result.user);
            }
            return result;
        } catch (e) {
            setError(e.message || 'Signup failed');
            throw e;
        } finally {
            setLoading(false);
        }
    }, []);

    const logout = useCallback(async () => {
        // Best-effort server-side revoke; even if it fails we drop the client session.
        try {
            await api.auth.logout();
        } catch (_) {
            // ignore — local clear is what matters
        }
        clearSession();
    }, [clearSession]);

    // Wire the api helper to read the current token and to call clearSession on 401.
    useEffect(() => {
        setAuthTokenGetter(() => tokenRef.current);
        setUnauthorizedHandler(() => {
            clearSession();
        });
    }, [clearSession]);

    const value = useMemo(
        () => ({
            token,
            user,
            isAuthenticated: Boolean(token),
            loading,
            error,
            login,
            signup,
            logout,
            clearError: () => setError(null),
        }),
        [token, user, loading, error, login, signup, logout]
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
