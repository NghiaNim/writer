import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
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
    const { login, signup, loading, error, clearError } = useAuth();
    const [mode, setMode] = useState('login'); // 'login' | 'signup'
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [localError, setLocalError] = useState(null);
    const [confirmationMessage, setConfirmationMessage] = useState(null);

    useEffect(() => {
        // Clear any stale error when the user toggles modes
        setLocalError(null);
        setConfirmationMessage(null);
        clearError();
    }, [mode, clearError]);

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
            setLocalError(e.message || 'Something went wrong.');
        }
    };

    const displayError = localError || error;
    const buttonLabel = mode === 'login' ? 'Sign in' : 'Create account';

    return (
        <div className="login-screen">
            <div className="login-card">
                <div className="login-header">
                    <h1 className="login-title">Essay Coach</h1>
                    <p className="login-subtitle">
                        Your council of writers, in one place.
                    </p>
                </div>

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
                            {displayError}
                        </div>
                    )}

                    <button type="submit" className="login-submit" disabled={loading}>
                        {loading ? 'Working...' : buttonLabel}
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
