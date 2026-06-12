import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';

// ---------------------------------------------------------------------------
// AutoGrowTextarea — used for the rule editor so long rules display fully
// instead of being truncated inside a single-line <input>.
// ---------------------------------------------------------------------------

function AutoGrowTextarea({ value, onChange, style, ...rest }) {
    const ref = useRef(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);
    return (
        <textarea
            ref={ref}
            value={value}
            onChange={onChange}
            rows={1}
            style={{
                resize: 'none',
                overflow: 'hidden',
                lineHeight: 1.5,
                ...style,
            }}
            {...rest}
        />
    );
}

// ---------------------------------------------------------------------------
// Style tokens (kept inline so this file ships without a sibling .css)
// ---------------------------------------------------------------------------

const colors = {
    panelBg: 'rgba(26, 19, 12, 0.55)',
    panelBorder: 'rgba(212, 145, 60, 0.18)',
    panelBorderActive: 'rgba(212, 145, 60, 0.45)',
    ruleBg: 'rgba(212, 145, 60, 0.08)',
    ruleBorder: 'rgba(212, 145, 60, 0.32)',
    pendingBg: 'rgba(232, 181, 88, 0.08)',
    pendingBorder: 'rgba(232, 181, 88, 0.32)',
    pendingText: '#f6e3bd',
    text: '#e8dcc6',
    textMuted: '#b9a988',
    error: '#e5a18d',
    errorBg: 'rgba(205, 106, 74, 0.1)',
    errorBorder: 'rgba(205, 106, 74, 0.28)',
    success: '#c4d29a',
    successBg: 'rgba(163, 181, 109, 0.1)',
    successBorder: 'rgba(163, 181, 109, 0.28)',
};

const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    background: 'rgba(0,0,0,0.3)',
    color: colors.text,
    border: `1px solid ${colors.panelBorder}`,
    borderRadius: '8px',
    fontFamily: 'inherit',
    fontSize: '14px',
    boxSizing: 'border-box',
};

const primaryButtonStyle = {
    background: '#d4913c',
    color: '#1a130c',
    border: 'none',
    borderRadius: '3px',
    padding: '9px 16px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
};

const secondaryButtonStyle = {
    background: 'rgba(255,255,255,0.06)',
    color: colors.text,
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '8px',
    padding: '9px 14px',
    cursor: 'pointer',
    fontSize: '13px',
};

const removeButtonStyle = {
    background: 'transparent',
    color: colors.error,
    border: '1px solid rgba(205, 106, 74, 0.4)',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '12px',
    cursor: 'pointer',
};

const acceptButtonStyle = {
    background: 'rgba(163, 181, 109, 0.12)',
    color: colors.success,
    border: '1px solid rgba(163, 181, 109, 0.4)',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '12px',
    cursor: 'pointer',
};

// Per-section panel wrapper — visible card with title + body.
function Panel({ title, count, accent, helper, children, action }) {
    return (
        <section
            style={{
                background: colors.panelBg,
                border: `1px solid ${accent ? colors.panelBorderActive : colors.panelBorder}`,
                borderRadius: '12px',
                padding: '20px 22px',
                marginBottom: '14px',
            }}
        >
            <header
                style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: '10px',
                    marginBottom: helper ? '6px' : '14px',
                }}
            >
                <h3
                    style={{
                        margin: 0,
                        fontSize: '17px',
                        fontWeight: 700,
                        color: colors.text,
                        letterSpacing: '-0.01em',
                    }}
                >
                    {title}
                    {typeof count === 'number' && (
                        <span style={{ color: colors.textMuted, fontWeight: 500, marginLeft: 8 }}>
                            ({count})
                        </span>
                    )}
                </h3>
                {action}
            </header>
            {helper && (
                <p
                    style={{
                        margin: '0 0 14px',
                        fontSize: '13px',
                        color: colors.textMuted,
                        lineHeight: 1.5,
                    }}
                >
                    {helper}
                </p>
            )}
            {children}
        </section>
    );
}

/**
 * Voice page — Supabase-backed, per-user. The Rules panel is intentionally
 * the visual centerpiece: it's the part of the profile that has the most
 * concrete effect on the council's output, so it owns the top of the page
 * and uses card-style chips instead of buried inputs.
 */
export default function VoiceProfileSettings() {
    const [rules, setRules] = useState([]);
    const [referenceParagraphs, setReferenceParagraphs] = useState([]);
    const [preferredAuthors, setPreferredAuthors] = useState([]);
    const [inferredStyle, setInferredStyle] = useState('');
    const [pendingSuggestions, setPendingSuggestions] = useState([]);
    const [savedSnapshot, setSavedSnapshot] = useState(null);

    const [newRule, setNewRule] = useState('');
    const [newParagraph, setNewParagraph] = useState('');
    const [newAuthor, setNewAuthor] = useState('');

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [suggesting, setSuggesting] = useState(false);
    const [restoringDefaults, setRestoringDefaults] = useState(false);
    // Inline two-step confirm so an accidental click doesn't repopulate
    // rules the user intentionally removed.
    const [restoreConfirming, setRestoreConfirming] = useState(false);
    const restoreConfirmTimerRef = useRef(null);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(false);

    const [profileFacts, setProfileFacts] = useState([]);
    const [newProfileFact, setNewProfileFact] = useState('');
    const [factsLoading, setFactsLoading] = useState(true);
    const [factBusy, setFactBusy] = useState(false);

    const computeSnapshot = (data) =>
        JSON.stringify({
            rules: data.rules || [],
            reference_paragraphs: data.reference_paragraphs || [],
            preferred_authors: data.preferred_authors || [],
            inferred_style: data.inferred_style || '',
        });

    const applyProfile = (data) => {
        setRules(data.rules || []);
        setReferenceParagraphs(data.reference_paragraphs || []);
        setPreferredAuthors(data.preferred_authors || []);
        setInferredStyle(data.inferred_style || '');
        setPendingSuggestions(data.pending_suggestions || []);
        setSavedSnapshot(computeSnapshot(data));
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const data = await api.voice.get();
                if (!cancelled) applyProfile(data);
            } catch (e) {
                if (!cancelled) setError(e.message || 'Could not load voice profile.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setFactsLoading(true);
            try {
                const res = await api.userFacts.list();
                if (!cancelled) setProfileFacts(res.facts || []);
            } catch {
                if (!cancelled) setProfileFacts([]);
            } finally {
                if (!cancelled) setFactsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const isDirty = useMemo(
        () =>
            savedSnapshot !== null &&
            savedSnapshot !==
                computeSnapshot({
                    rules,
                    reference_paragraphs: referenceParagraphs,
                    preferred_authors: preferredAuthors,
                    inferred_style: inferredStyle,
                }),
        [savedSnapshot, rules, referenceParagraphs, preferredAuthors, inferredStyle]
    );

    // ----- Rules -----
    const ruleSet = useMemo(
        () => new Set(rules.map((r) => (r || '').trim().toLowerCase())),
        [rules]
    );

    const addRule = (value) => {
        const v = (value || '').trim();
        if (!v) return;
        if (ruleSet.has(v.toLowerCase())) return;
        setRules((prev) => [...prev, v]);
    };

    const handleAddTypedRule = () => {
        addRule(newRule);
        setNewRule('');
    };

    // Two-step "Restore defaults": first click arms the confirm state and
    // starts a 4s timer to reset it; second click within that window pulls
    // DEFAULT_VOICE_RULES from the server and adds any rule the user doesn't
    // already have. Never removes or reorders existing rules.
    const handleRestoreDefaults = async () => {
        if (restoringDefaults) return;
        if (!restoreConfirming) {
            setRestoreConfirming(true);
            if (restoreConfirmTimerRef.current) {
                clearTimeout(restoreConfirmTimerRef.current);
            }
            restoreConfirmTimerRef.current = setTimeout(() => {
                setRestoreConfirming(false);
                restoreConfirmTimerRef.current = null;
            }, 4000);
            return;
        }
        if (restoreConfirmTimerRef.current) {
            clearTimeout(restoreConfirmTimerRef.current);
            restoreConfirmTimerRef.current = null;
        }
        setRestoreConfirming(false);
        setRestoringDefaults(true);
        setError(null);
        try {
            const { rules: defaults = [] } = await api.voice.defaults();
            const existing = new Set(rules.map((r) => (r || '').trim().toLowerCase()));
            const missing = defaults.filter(
                (r) => r && !existing.has(r.trim().toLowerCase())
            );
            if (!missing.length) {
                // Already have every default. Surface that explicitly so a
                // user clicking the button doesn't think it silently failed.
                setError('You already have all the default rules — nothing to restore.');
                return;
            }
            const nextRules = [...rules, ...missing];
            setRules(nextRules);
            // Persist immediately. The previous version stopped at setRules
            // and required the user to ALSO press Save Voice Profile, which
            // most people don't notice — making the button feel like a no-op.
            const updated = await api.voice.save({
                rules: nextRules,
                reference_paragraphs: referenceParagraphs,
                preferred_authors: preferredAuthors,
                inferred_style: inferredStyle,
            });
            applyProfile(updated);
            setSuccess(true);
            setTimeout(() => setSuccess(false), 2500);
        } catch (e) {
            setError(e.message || 'Failed to restore default rules');
        } finally {
            setRestoringDefaults(false);
        }
    };

    // Clean up the confirm timer on unmount so it doesn't fire against a
    // stale setter after the user navigates away.
    useEffect(() => {
        return () => {
            if (restoreConfirmTimerRef.current) {
                clearTimeout(restoreConfirmTimerRef.current);
            }
        };
    }, []);

    const removeRule = (idx) => setRules((prev) => prev.filter((_, i) => i !== idx));
    const editRule = (idx, value) =>
        setRules((prev) => prev.map((r, i) => (i === idx ? value : r)));

    // ----- Reference paragraphs -----
    const addParagraph = () => {
        const v = newParagraph.trim();
        if (!v) return;
        setReferenceParagraphs((prev) => [...prev, v]);
        setNewParagraph('');
    };
    const removeParagraph = (idx) =>
        setReferenceParagraphs((prev) => prev.filter((_, i) => i !== idx));

    // Upload a plain-text or markdown writing sample. Splits the file
    // into paragraphs on blank lines and appends each as its own
    // reference. Caps each upload at 10 paragraphs and 8KB per
    // paragraph so a runaway file can't blow up the voice profile.
    const handleSampleFile = async (file) => {
        if (!file) return;
        if (file.size > 200_000) {
            setError('That file is bigger than 200KB — try pasting a shorter excerpt instead.');
            return;
        }
        setError(null);
        try {
            const text = await file.text();
            const paragraphs = text
                .split(/\n\s*\n+/)
                .map((p) => p.trim())
                .filter((p) => p.length > 30 && p.length <= 8000)
                .slice(0, 10);
            if (paragraphs.length === 0) {
                setError('Could not find usable paragraphs in that file — make sure it has blank lines between paragraphs.');
                return;
            }
            setReferenceParagraphs((prev) => [...prev, ...paragraphs]);
            setSuccess(true);
            setTimeout(() => setSuccess(false), 2500);
        } catch (e) {
            setError(e?.message || 'Could not read that file.');
        }
    };

    // ----- Preferred authors -----
    const addAuthor = () => {
        const v = newAuthor.trim();
        if (!v) return;
        if (preferredAuthors.length >= 5) return;
        if (preferredAuthors.some((a) => a.toLowerCase() === v.toLowerCase())) return;
        setPreferredAuthors((prev) => [...prev, v]);
        setNewAuthor('');
    };
    const removeAuthor = (idx) =>
        setPreferredAuthors((prev) => prev.filter((_, i) => i !== idx));

    const handleAddProfileFact = async () => {
        const v = newProfileFact.trim();
        if (!v) return;
        setFactBusy(true);
        try {
            const row = await api.userFacts.create(v, 'manual');
            setProfileFacts((prev) => [row, ...prev]);
            setNewProfileFact('');
        } catch (e) {
            setError(e.message || 'Could not save fact.');
        } finally {
            setFactBusy(false);
        }
    };

    const handleRemoveProfileFact = async (id) => {
        setFactBusy(true);
        try {
            await api.userFacts.delete(id);
            setProfileFacts((prev) => prev.filter((f) => f.id !== id));
        } catch (e) {
            setError(e.message || 'Could not delete fact.');
        } finally {
            setFactBusy(false);
        }
    };

    // ----- Save -----
    const handleSave = async () => {
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            const updated = await api.voice.save({
                rules,
                reference_paragraphs: referenceParagraphs,
                preferred_authors: preferredAuthors,
                inferred_style: inferredStyle,
            });
            applyProfile(updated);
            setSuccess(true);
            setTimeout(() => setSuccess(false), 2000);
        } catch (e) {
            setError(e.message || 'Could not save voice profile.');
        } finally {
            setSaving(false);
        }
    };

    // ----- Review queue -----
    const handleSuggestRules = async () => {
        if (!referenceParagraphs.length) {
            setError('Add at least one reference paragraph before asking for suggestions.');
            return;
        }
        setSuggesting(true);
        setError(null);
        try {
            const updated = await api.voice.suggestRules({ source: 'reference_paragraphs' });
            applyProfile(updated);
        } catch (e) {
            setError(e.message || 'Could not get suggestions.');
        } finally {
            setSuggesting(false);
        }
    };

    const handleAccept = async (id) => {
        try {
            const updated = await api.voice.acceptSuggestion(id);
            applyProfile(updated);
        } catch (e) {
            setError(e.message || 'Could not accept suggestion.');
        }
    };

    const handleReject = async (id) => {
        try {
            const updated = await api.voice.rejectSuggestion(id);
            applyProfile(updated);
        } catch (e) {
            setError(e.message || 'Could not reject suggestion.');
        }
    };

    if (loading) {
        return <div style={{ color: colors.textMuted }}>Loading voice profile…</div>;
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
            {/* ---------- Page header ---------- */}
            <div style={{ marginBottom: '20px' }}>
                <h2
                    style={{
                        margin: 0,
                        fontSize: '24px',
                        fontWeight: 700,
                        color: colors.text,
                        letterSpacing: '-0.015em',
                    }}
                >
                    My Voice
                </h2>
                <p
                    style={{
                        margin: '6px 0 0',
                        fontSize: '14px',
                        color: colors.textMuted,
                        lineHeight: 1.5,
                    }}
                >
                    <strong style={{ color: colors.text }}>Applied to every essay</strong> the council writes. Even three rules change the output.
                </p>
            </div>

            {/* ---------- Banners ---------- */}
            {error && (
                <div
                    style={{
                        padding: '10px 14px',
                        background: colors.errorBg,
                        color: colors.error,
                        border: `1px solid ${colors.errorBorder}`,
                        borderRadius: '8px',
                        fontSize: '13px',
                        lineHeight: 1.5,
                        marginBottom: '14px',
                        whiteSpace: 'pre-wrap',
                    }}
                >
                    {error}
                </div>
            )}
            {success && (
                <div
                    style={{
                        padding: '10px 14px',
                        background: colors.successBg,
                        color: colors.success,
                        border: `1px solid ${colors.successBorder}`,
                        borderRadius: '8px',
                        fontSize: '13px',
                        marginBottom: '14px',
                    }}
                >
                    Saved.
                </div>
            )}

            {/* ---------- 1. Rules — the centerpiece ---------- */}
            <Panel
                title="Rules the council follows"
                count={rules.length}
                accent={rules.length > 0}
                helper="One concrete rule per line. Applied to every essay."
                action={
                    <button
                        type="button"
                        onClick={handleRestoreDefaults}
                        disabled={restoringDefaults}
                        title={
                            restoreConfirming
                                ? 'Click again to confirm. Existing rules will not be removed.'
                                : "Add any default rules you don't already have. Won't remove or change your existing rules."
                        }
                        style={{
                            background: restoreConfirming
                                ? 'rgba(232, 181, 88, 0.12)'
                                : 'transparent',
                            color: restoreConfirming ? '#e8b558' : colors.textMuted,
                            border: `1px dashed ${
                                restoreConfirming
                                    ? 'rgba(232, 181, 88, 0.55)'
                                    : colors.panelBorder
                            }`,
                            borderRadius: '999px',
                            padding: '4px 12px',
                            fontSize: '12px',
                            cursor: restoringDefaults ? 'wait' : 'pointer',
                            fontFamily: 'inherit',
                            opacity: restoringDefaults ? 0.6 : 1,
                            transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                        }}
                    >
                        {restoringDefaults
                            ? 'Restoring…'
                            : restoreConfirming
                                ? 'Click again to confirm'
                                : 'Restore defaults'}
                    </button>
                }
            >
                {rules.length === 0 ? (
                    <div
                        style={{
                            padding: '18px',
                            background: 'rgba(0,0,0,0.18)',
                            border: `1px dashed ${colors.panelBorder}`,
                            borderRadius: '10px',
                            color: colors.textMuted,
                            fontSize: '13px',
                            lineHeight: 1.5,
                            marginBottom: '14px',
                        }}
                    >
                        No rules yet. Type one below — the council applies every rule on this list.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
                        {rules.map((rule, idx) => (
                            <div
                                key={idx}
                                style={{
                                    display: 'flex',
                                    gap: '8px',
                                    alignItems: 'flex-start',
                                    padding: '10px 12px',
                                    background: colors.ruleBg,
                                    border: `1px solid ${colors.ruleBorder}`,
                                    borderRadius: '10px',
                                }}
                            >
                                <span
                                    aria-hidden
                                    style={{
                                        color: '#e9c285',
                                        fontWeight: 700,
                                        fontSize: '13px',
                                        minWidth: '24px',
                                        paddingTop: '4px',
                                    }}
                                >
                                    {idx + 1}.
                                </span>
                                <AutoGrowTextarea
                                    value={rule}
                                    onChange={(e) => editRule(idx, e.target.value)}
                                    style={{
                                        ...inputStyle,
                                        flex: 1,
                                        background: 'transparent',
                                        border: '1px solid transparent',
                                        padding: '4px 6px',
                                        minHeight: '28px',
                                    }}
                                    aria-label={`Rule ${idx + 1}`}
                                />
                                <button
                                    type="button"
                                    style={{
                                        ...removeButtonStyle,
                                        marginTop: '2px',
                                        flexShrink: 0,
                                    }}
                                    onClick={() => removeRule(idx)}
                                >
                                    Remove
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {/* Inline add */}
                <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                        type="text"
                        value={newRule}
                        onChange={(e) => setNewRule(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddTypedRule()}
                        placeholder='e.g. "no em-dashes" or "avoid the word delve"'
                        style={{ ...inputStyle, flex: 1 }}
                    />
                    <button
                        type="button"
                        style={primaryButtonStyle}
                        onClick={handleAddTypedRule}
                        disabled={!newRule.trim()}
                    >
                        Add rule
                    </button>
                </div>

            </Panel>

            {/* ---------- 2. Pending review queue ---------- */}
            {pendingSuggestions.length > 0 && (
                <Panel
                    title="Pending suggestions"
                    count={pendingSuggestions.length}
                    helper="Pulled from your reference samples. Nothing applies until you accept."
                >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {pendingSuggestions.map((s) => (
                            <div
                                key={s.id}
                                style={{
                                    padding: '12px 14px',
                                    background: colors.pendingBg,
                                    border: `1px solid ${colors.pendingBorder}`,
                                    borderRadius: '10px',
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    justifyContent: 'space-between',
                                    gap: '10px',
                                }}
                            >
                                <div style={{ flex: 1, color: colors.pendingText }}>
                                    <div style={{ fontSize: '13px', lineHeight: 1.5 }}>{s.rule}</div>
                                    <div
                                        style={{
                                            marginTop: '4px',
                                            fontSize: '11px',
                                            color: 'rgba(253, 230, 138, 0.65)',
                                        }}
                                    >
                                        suggested from {s.source || 'unknown'}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                    <button
                                        type="button"
                                        style={acceptButtonStyle}
                                        onClick={() => handleAccept(s.id)}
                                    >
                                        Accept
                                    </button>
                                    <button
                                        type="button"
                                        style={removeButtonStyle}
                                        onClick={() => handleReject(s.id)}
                                    >
                                        Reject
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </Panel>
            )}

            {/* ---------- 3. Reference samples ---------- */}
            <Panel
                title="Reference samples"
                count={referenceParagraphs.length}
                helper="Paste paragraphs of your writing. Tap “Suggest rules” to extract style rules from them."
                action={
                    referenceParagraphs.length > 0 ? (
                        <button
                            type="button"
                            style={secondaryButtonStyle}
                            onClick={handleSuggestRules}
                            disabled={suggesting}
                        >
                            {suggesting ? 'Reading…' : 'Suggest rules from these'}
                        </button>
                    ) : null
                }
            >
                {referenceParagraphs.map((para, idx) => (
                    <div
                        key={idx}
                        style={{
                            padding: '12px 14px',
                            background: colors.ruleBg,
                            border: `1px solid ${colors.ruleBorder}`,
                            borderRadius: '10px',
                            marginBottom: '8px',
                        }}
                    >
                        <div
                            style={{
                                color: colors.text,
                                fontFamily: 'var(--font-content, serif)',
                                whiteSpace: 'pre-wrap',
                                fontSize: '14px',
                                lineHeight: 1.55,
                                marginBottom: '8px',
                            }}
                        >
                            {para}
                        </div>
                        <button
                            type="button"
                            style={removeButtonStyle}
                            onClick={() => removeParagraph(idx)}
                        >
                            Remove
                        </button>
                    </div>
                ))}
                <textarea
                    value={newParagraph}
                    onChange={(e) => setNewParagraph(e.target.value)}
                    placeholder="Paste a paragraph of your own writing…"
                    rows={4}
                    style={{ ...inputStyle, fontFamily: 'var(--font-content, serif)', resize: 'vertical' }}
                />
                <div
                    style={{
                        display: 'flex',
                        gap: '8px',
                        marginTop: '8px',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                    }}
                >
                    {/* Hidden input + clickable label = browser file picker.
                        Limits to .txt and .md because we read with file.text();
                        .docx and .pdf would need parsing libraries. Users with
                        Word/Google Docs export to .txt first. */}
                    <input
                        type="file"
                        id="voice-sample-upload"
                        accept=".txt,.md,text/plain,text/markdown"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            handleSampleFile(file);
                            e.target.value = '';
                        }}
                    />
                    <label
                        htmlFor="voice-sample-upload"
                        style={{
                            ...secondaryButtonStyle,
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                        }}
                        title="Upload a .txt or .md file of your own writing — paragraphs will be added as separate samples"
                    >
                        <span aria-hidden="true">📎</span>
                        Upload a sample (.txt, .md)
                    </label>
                    <button
                        type="button"
                        style={secondaryButtonStyle}
                        onClick={addParagraph}
                        disabled={!newParagraph.trim()}
                    >
                        Add sample
                    </button>
                </div>
            </Panel>

            {/* ---------- 4. Preferred authors ---------- */}
            <Panel
                title="Authors I admire"
                count={preferredAuthors.length}
                helper="Up to 5. The council uses these as a stylistic anchor — it won't quote them or name them in your essay."
            >
                {preferredAuthors.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                        {preferredAuthors.map((a, idx) => (
                            <span
                                key={idx}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '5px 10px',
                                    background: colors.ruleBg,
                                    border: `1px solid ${colors.ruleBorder}`,
                                    borderRadius: '999px',
                                    color: colors.text,
                                    fontSize: '13px',
                                }}
                            >
                                {a}
                                <button
                                    type="button"
                                    onClick={() => removeAuthor(idx)}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        color: colors.textMuted,
                                        cursor: 'pointer',
                                        padding: 0,
                                        fontSize: '14px',
                                    }}
                                    aria-label={`Remove ${a}`}
                                >
                                    ×
                                </button>
                            </span>
                        ))}
                    </div>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                        type="text"
                        value={newAuthor}
                        onChange={(e) => setNewAuthor(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addAuthor()}
                        placeholder="e.g. Joan Didion"
                        style={{ ...inputStyle, flex: 1 }}
                        disabled={preferredAuthors.length >= 5}
                    />
                    <button
                        type="button"
                        style={secondaryButtonStyle}
                        onClick={addAuthor}
                        disabled={preferredAuthors.length >= 5 || !newAuthor.trim()}
                    >
                        Add
                    </button>
                </div>
            </Panel>

            <Panel
                title="Profile facts"
                count={profileFacts.length}
                helper="Things the council should remember (achievements, background, constraints)."
            >
                {factsLoading ? (
                    <div style={{ color: colors.textMuted, fontSize: '13px' }}>Loading facts…</div>
                ) : profileFacts.length === 0 ? (
                    <p style={{ margin: 0, fontSize: '13px', color: colors.textMuted }}>
                        No saved facts yet. Add a few below (e.g. Olympic gold medalist in rowing, 2024).
                    </p>
                ) : (
                    <ul style={{ margin: '0 0 12px', paddingLeft: '18px', color: colors.text }}>
                        {profileFacts.map((f) => (
                            <li key={f.id} style={{ marginBottom: '8px' }}>
                                <span style={{ marginRight: '8px' }}>{f.fact_text}</span>
                                <button
                                    type="button"
                                    style={removeButtonStyle}
                                    onClick={() => handleRemoveProfileFact(f.id)}
                                    disabled={factBusy}
                                >
                                    Remove
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                        type="text"
                        value={newProfileFact}
                        onChange={(e) => setNewProfileFact(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddProfileFact()}
                        placeholder="e.g. First-generation college student; grew up in rural Maine"
                        style={{ ...inputStyle, flex: 1 }}
                        disabled={factBusy}
                    />
                    <button
                        type="button"
                        style={secondaryButtonStyle}
                        onClick={handleAddProfileFact}
                        disabled={factBusy || !newProfileFact.trim()}
                    >
                        Add fact
                    </button>
                </div>
            </Panel>

            {/* ---------- 5. Inferred style summary ---------- */}
            <Panel
                title="Inferred style summary"
                helper="A short sentence at the top of your profile. Auto-filled by Suggest rules."
            >
                <textarea
                    value={inferredStyle}
                    onChange={(e) => setInferredStyle(e.target.value)}
                    placeholder="A 1–2 sentence description of your voice."
                    rows={3}
                    style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
                />
            </Panel>

            {/* ---------- Sticky save row ---------- */}
            <div
                style={{
                    position: 'sticky',
                    bottom: 0,
                    background:
                        'linear-gradient(180deg, rgba(26, 19, 12, 0) 0%, rgba(26, 19, 12, 0.9) 30%, rgba(26, 19, 12, 0.96) 100%)',
                    paddingTop: '24px',
                    paddingBottom: '16px',
                    marginTop: '8px',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '8px',
                }}
            >
                <button
                    type="button"
                    style={{
                        ...primaryButtonStyle,
                        opacity: !isDirty ? 0.6 : 1,
                        cursor: !isDirty ? 'default' : 'pointer',
                    }}
                    onClick={handleSave}
                    disabled={saving || !isDirty}
                >
                    {saving ? 'Saving…' : isDirty ? 'Save voice profile' : 'All changes saved'}
                </button>
            </div>
        </div>
    );
}
