import React, { useEffect, useState } from 'react';
import { api } from '../../api';

const inputStyle = {
    width: '100%',
    padding: '8px 10px',
    background: 'rgba(0,0,0,0.25)',
    color: '#e2e8f0',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '6px',
    fontFamily: 'inherit',
    fontSize: '14px',
    boxSizing: 'border-box',
};

const cardStyle = {
    padding: '12px 14px',
    background: 'rgba(59, 130, 246, 0.06)',
    border: '1px solid rgba(59, 130, 246, 0.18)',
    borderRadius: '8px',
    marginBottom: '8px',
};

const pendingCardStyle = {
    padding: '12px 14px',
    background: 'rgba(251, 191, 36, 0.08)',
    border: '1px solid rgba(251, 191, 36, 0.28)',
    borderRadius: '8px',
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '10px',
};

const removeButtonStyle = {
    background: 'transparent',
    color: '#f87171',
    border: '1px solid rgba(248, 113, 113, 0.4)',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '12px',
    cursor: 'pointer',
};

const acceptButtonStyle = {
    background: 'rgba(34, 197, 94, 0.12)',
    color: '#86efac',
    border: '1px solid rgba(34, 197, 94, 0.4)',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '12px',
    cursor: 'pointer',
};

const primaryButtonStyle = {
    background: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    padding: '8px 14px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
};

const secondaryButtonStyle = {
    background: 'rgba(255,255,255,0.06)',
    color: '#e2e8f0',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '6px',
    padding: '8px 14px',
    cursor: 'pointer',
    fontSize: '13px',
};

const sectionLabelStyle = {
    fontFamily: 'var(--font-display, inherit)',
    fontSize: '13px',
    fontWeight: 600,
    color: '#cbd5e1',
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    margin: '24px 0 8px',
};

/**
 * Voice page (per-user, Supabase-backed).
 *
 * Sections:
 *   1. Rules            — canonical, user-editable list. Add / delete / inline edit.
 *   2. Pending review   — AI-suggested rules awaiting Accept / Reject. Never auto-commit.
 *   3. Reference samples — user pastes their own writing; "Suggest rules" turns them into pending suggestions.
 *   4. Preferred authors — names captured during intake, also editable here.
 *   5. Inferred style   — short LLM-written summary, editable.
 *
 * Manual save persists rules / reference_paragraphs / inferred_style /
 * preferred_authors. The review queue endpoints (suggest / accept / reject)
 * mutate state independently and re-fetch.
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
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(false);

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

    const isDirty = savedSnapshot !== null && savedSnapshot !== computeSnapshot({
        rules,
        reference_paragraphs: referenceParagraphs,
        preferred_authors: preferredAuthors,
        inferred_style: inferredStyle,
    });

    // ----- Rules -----
    const addRule = () => {
        const v = newRule.trim();
        if (!v) return;
        setRules((prev) => [...prev, v]);
        setNewRule('');
    };

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

    // ----- Preferred authors -----
    const addAuthor = () => {
        const v = newAuthor.trim();
        if (!v) return;
        if (preferredAuthors.length >= 5) return;
        setPreferredAuthors((prev) => [...prev, v]);
        setNewAuthor('');
    };
    const removeAuthor = (idx) =>
        setPreferredAuthors((prev) => prev.filter((_, i) => i !== idx));

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
        return <div style={{ color: '#94a3b8' }}>Loading voice profile…</div>;
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ marginBottom: '8px' }}>
                <h2 style={{ margin: 0, fontSize: '20px', color: '#e2e8f0' }}>My Voice</h2>
                <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#94a3b8' }}>
                    The council leans into this profile when writing. Add rules you want it to
                    follow, drop in samples of your real writing, and accept any suggestions you
                    agree with.
                </p>
            </div>

            {error && (
                <div
                    style={{
                        padding: '9px 12px',
                        background: 'rgba(248, 113, 113, 0.08)',
                        color: '#fca5a5',
                        border: '1px solid rgba(248, 113, 113, 0.25)',
                        borderRadius: '6px',
                        fontSize: '13px',
                    }}
                >
                    {error}
                </div>
            )}
            {success && (
                <div
                    style={{
                        padding: '9px 12px',
                        background: 'rgba(34, 197, 94, 0.08)',
                        color: '#86efac',
                        border: '1px solid rgba(34, 197, 94, 0.25)',
                        borderRadius: '6px',
                        fontSize: '13px',
                    }}
                >
                    Saved.
                </div>
            )}

            {/* ---- Rules ---- */}
            <div style={sectionLabelStyle}>Rules ({rules.length})</div>
            {rules.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '8px' }}>
                    No rules yet. Add concrete style instructions like "no em-dashes" or "lean
                    shorter sentences".
                </div>
            )}
            {rules.map((rule, idx) => (
                <div key={idx} style={cardStyle}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                        <input
                            type="text"
                            value={rule}
                            onChange={(e) => editRule(idx, e.target.value)}
                            style={{ ...inputStyle, flex: 1 }}
                        />
                        <button
                            type="button"
                            style={removeButtonStyle}
                            onClick={() => removeRule(idx)}
                        >
                            Remove
                        </button>
                    </div>
                </div>
            ))}
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <input
                    type="text"
                    value={newRule}
                    onChange={(e) => setNewRule(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addRule()}
                    placeholder='e.g. "no em-dashes" or "avoid the word delve"'
                    style={{ ...inputStyle, flex: 1 }}
                />
                <button type="button" style={secondaryButtonStyle} onClick={addRule}>
                    Add rule
                </button>
            </div>

            {/* ---- Pending review queue ---- */}
            <div style={sectionLabelStyle}>
                Pending suggestions ({pendingSuggestions.length})
            </div>
            {pendingSuggestions.length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '8px' }}>
                    Nothing pending. After you add reference samples below, hit "Suggest rules
                    from my samples" to populate this queue.
                </div>
            ) : (
                pendingSuggestions.map((s) => (
                    <div key={s.id} style={pendingCardStyle}>
                        <div style={{ flex: 1, color: '#fde68a' }}>
                            <div style={{ fontSize: '13px', lineHeight: 1.4 }}>{s.rule}</div>
                            <div
                                style={{
                                    marginTop: '4px',
                                    fontSize: '11px',
                                    color: 'rgba(253, 230, 138, 0.65)',
                                }}
                            >
                                from {s.source || 'unknown'}
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
                ))
            )}

            {/* ---- Reference paragraphs ---- */}
            <div style={sectionLabelStyle}>
                Reference samples ({referenceParagraphs.length})
            </div>
            <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '8px' }}>
                Paste a paragraph of your own writing. The council uses these as voice anchors,
                and "Suggest rules" extracts concrete rules from them.
            </div>
            {referenceParagraphs.map((para, idx) => (
                <div key={idx} style={cardStyle}>
                    <div
                        style={{
                            color: '#e2e8f0',
                            fontFamily: 'var(--font-content, serif)',
                            whiteSpace: 'pre-wrap',
                            fontSize: '14px',
                            lineHeight: 1.5,
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
                style={{ ...inputStyle, fontFamily: 'var(--font-content, serif)' }}
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button type="button" style={secondaryButtonStyle} onClick={addParagraph}>
                    Add sample
                </button>
                <button
                    type="button"
                    style={primaryButtonStyle}
                    onClick={handleSuggestRules}
                    disabled={suggesting || !referenceParagraphs.length}
                >
                    {suggesting ? 'Reading samples…' : 'Suggest rules from my samples'}
                </button>
            </div>

            {/* ---- Preferred authors ---- */}
            <div style={sectionLabelStyle}>
                Authors I admire ({preferredAuthors.length}/5)
            </div>
            <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '8px' }}>
                Up to 5. The council uses these as a stylistic anchor — it won't quote or name
                them in your essay.
            </div>
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px',
                    marginBottom: '6px',
                }}
            >
                {preferredAuthors.map((a, idx) => (
                    <span
                        key={idx}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '4px 10px',
                            background: 'rgba(59, 130, 246, 0.1)',
                            border: '1px solid rgba(59, 130, 246, 0.3)',
                            borderRadius: '999px',
                            color: '#e2e8f0',
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
                                color: '#cbd5e1',
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
                    disabled={preferredAuthors.length >= 5}
                >
                    Add
                </button>
            </div>

            {/* ---- Inferred style ---- */}
            <div style={sectionLabelStyle}>Inferred style summary</div>
            <textarea
                value={inferredStyle}
                onChange={(e) => setInferredStyle(e.target.value)}
                placeholder="A 1-2 sentence description of your voice. Auto-filled when you ask for rule suggestions; editable."
                rows={3}
                style={{ ...inputStyle, fontFamily: 'inherit' }}
            />

            {/* ---- Save ---- */}
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '8px',
                    marginTop: '24px',
                }}
            >
                <button
                    type="button"
                    style={primaryButtonStyle}
                    onClick={handleSave}
                    disabled={saving || !isDirty}
                >
                    {saving ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
                </button>
            </div>
        </div>
    );
}
