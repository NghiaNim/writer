import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api, API_BASE, warmUpBackend } from '../api';
import './Login.css';

/**
 * Login / signup screen (Phase 1).
 *
 * Single screen with a toggle between "Sign in" and "Create account".
 * On success the AuthProvider stores the token in memory and the rest of
 * the app renders. On signup with email confirmation enabled the user
 * sees a "check your email" message instead of being logged in.
 */
export default function Login() {
    const { login, signup, loginWithGoogleCode, loading, error, clearError } = useAuth();
    const [mode, setMode] = useState('login'); // 'login' | 'signup'
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [localError, setLocalError] = useState(null);
    const [confirmationMessage, setConfirmationMessage] = useState(null);
    const oauthCodeHandledRef = useRef(false);
    // 'pending' until the warm-up ping returns; 'up' on success; 'down' on
    // failure. Render's free tier sleeps after ~15min and takes 30-60s to
    // wake; we surface this so users understand the first-attempt failure.
    const [backendStatus, setBackendStatus] = useState('pending');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const latency = await warmUpBackend();
            if (cancelled) return;
            setBackendStatus(latency === null ? 'down' : 'up');
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const url = new URL(window.location.href);
        const code = url.searchParams.get('code');
        if (!code || oauthCodeHandledRef.current) return;
        oauthCodeHandledRef.current = true;

        let cancelled = false;
        setLocalError(null);
        setConfirmationMessage('Completing Google sign-in...');

        (async () => {
            try {
                const redirectTo = `${window.location.origin}${window.location.pathname}`;
                await loginWithGoogleCode(code, redirectTo);
                window.history.replaceState({}, document.title, window.location.pathname);
            } catch (e) {
                if (!cancelled) {
                    setConfirmationMessage(null);
                    setLocalError(e?.message || 'Google sign-in failed');
                    window.history.replaceState({}, document.title, window.location.pathname);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [loginWithGoogleCode]);

    useEffect(() => {
        // Clear any stale error when the user toggles modes. Intentionally
        // depends only on `mode` — earlier we also depended on `clearError`,
        // but AuthContext recreated that function on every re-render, which
        // caused the effect to fire after we set an error and silently wipe
        // it before paint. Only mode changes should clear errors here.
        setLocalError(null);
        setConfirmationMessage(null);
        clearError();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLocalError(null);
        setConfirmationMessage(null);

        const trimmedEmail = email.trim();
        if (!trimmedEmail || !password) {
            setLocalError('Email and password are required.');
            return;
        }
        if (mode === 'signup' && password.length < 6) {
            setLocalError('Password must be at least 6 characters.');
            return;
        }

        try {
            if (mode === 'login') {
                await login(trimmedEmail, password);
            } else {
                const result = await signup(trimmedEmail, password);
                if (!result.access_token && result.needs_email_confirmation) {
                    setConfirmationMessage(
                        'Account created. Check your email to confirm, then sign in.'
                    );
                    setMode('login');
                    setPassword('');
                }
            }
        } catch (e) {
            // Always log to console too so the user has it in dev tools even
            // if the on-screen render somehow fails.
            // eslint-disable-next-line no-console
            console.error(`[${mode}] failed against ${API_BASE}:`, e);
            let msg =
                (typeof e?.message === 'string' && e.message.trim()) ||
                (typeof e?.toString === 'function' && e.toString()) ||
                '';
            if (!msg || msg === '[object Object]') {
                msg = `Something went wrong during ${mode} (no error message returned). See browser console for details.`;
            }
            // If the warm-up never came back, prepend a hint — the user is
            // probably hitting a cold backend.
            if (backendStatus !== 'up') {
                msg =
                    'The server is still waking up (Render free tier cold start). ' +
                    'Wait ~30 seconds and try again.\n\nOriginal error: ' +
                    msg;
            }
            setLocalError(msg);
        }
    };

    const handleGoogleSignIn = async () => {
        setLocalError(null);
        setConfirmationMessage(null);
        try {
            const redirectTo = `${window.location.origin}${window.location.pathname}`;
            const { url } = await api.auth.getGoogleLoginUrl(redirectTo);
            window.location.assign(url);
        } catch (e) {
            setLocalError(e?.message || 'Could not start Google sign-in');
        }
    };

    const displayError = localError || error;
    const buttonLabel = mode === 'login' ? 'Sign in' : 'Create account';

    return (
        <div className="login-screen login-screen--coffee">
            <div className="login-card">
                <div className="login-header">
                    <h1 className="login-title">
                        <span
                            className="coffee-bean login-title-bean"
                            aria-hidden="true"
                        />
                        MidnightCoffee
                    </h1>
                    <p className="login-subtitle">
                        Slow writing, with a small council. Pour something good.
                    </p>
                </div>

                {backendStatus === 'pending' && (
                    <div className="login-status pending" role="status">
                        Waking up the server… (cold starts can take 30-60s)
                    </div>
                )}
                {backendStatus === 'down' && (
                    <div className="login-status down" role="status">
                        Server isn't responding yet. Try again in a few seconds.
                    </div>
                )}

                <div className="login-tabs" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'login'}
                        className={`login-tab ${mode === 'login' ? 'is-active' : ''}`}
                        onClick={() => setMode('login')}
                    >
                        Sign in
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'signup'}
                        className={`login-tab ${mode === 'signup' ? 'is-active' : ''}`}
                        onClick={() => setMode('signup')}
                    >
                        Create account
                    </button>
                </div>

                <form className="login-form" onSubmit={handleSubmit} noValidate>
                    <label className="login-field">
                        <span className="login-label">Email</span>
                        <input
                            type="email"
                            autoComplete="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@school.edu"
                            disabled={loading}
                            required
                        />
                    </label>

                    <label className="login-field">
                        <span className="login-label">Password</span>
                        <input
                            type="password"
                            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={mode === 'login' ? 'Your password' : 'At least 6 characters'}
                            disabled={loading}
                            minLength={mode === 'signup' ? 6 : undefined}
                            required
                        />
                    </label>

                    {confirmationMessage && (
                        <div className="login-info" role="status">
                            {confirmationMessage}
                        </div>
                    )}

                    {displayError && (
                        <div className="login-error" role="alert">
                            <div className="login-error-msg">{displayError}</div>
                        </div>
                    )}

                    <button type="submit" className="login-submit" disabled={loading}>
                        {loading ? 'Working...' : buttonLabel}
                    </button>
                    <button
                        type="button"
                        className="login-google"
                        disabled={loading}
                        onClick={handleGoogleSignIn}
                    >
                        Continue with Google
                    </button>
                </form>

                <div className="login-footer">
                    {mode === 'login' ? (
                        <p>
                            New here?{' '}
                            <button
                                type="button"
                                className="login-link"
                                onClick={() => setMode('signup')}
                                disabled={loading}
                            >
                                Create an account
                            </button>
                        </p>
                    ) : (
                        <p>
                            Already have an account?{' '}
                            <button
                                type="button"
                                className="login-link"
                                onClick={() => setMode('login')}
                                disabled={loading}
                            >
                                Sign in
                            </button>
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
