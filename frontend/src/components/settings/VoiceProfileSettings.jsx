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
};

const cardStyle = {
    padding: '12px 14px',
    background: 'rgba(59, 130, 246, 0.06)',
    border: '1px solid rgba(59, 130, 246, 0.18)',
    borderRadius: '8px',
    marginBottom: '8px',
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

export default function VoiceProfileSettings() {
    const [rules, setRules] = useState([]);
    const [referenceParagraphs, setReferenceParagraphs] = useState([]);
    const [inferredStyle, setInferredStyle] = useState('');
    const [savedSnapshot, setSavedSnapshot] = useState(null);

    const [newRule, setNewRule] = useState('');
    const [newParagraph, setNewParagraph] = useState('');

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const data = await api.getVoiceProfile();
                if (cancelled) return;
                setRules(data.rules || []);
                setReferenceParagraphs(data.reference_paragraphs || []);
                setInferredStyle(data.inferred_style || '');
                setSavedSnapshot(JSON.stringify({
                    rules: data.rules || [],
                    reference_paragraphs: data.reference_paragraphs || [],
                    inferred_style: data.inferred_style || '',
                }));
            } catch (err) {
                if (!cancelled) setError('Failed to load voice profile');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const currentSnapshot = JSON.stringify({
        rules,
        reference_paragraphs: referenceParagraphs,
        inferred_style: inferredStyle,
    });
    const isDirty = savedSnapshot !== null && currentSnapshot !== savedSnapshot;

    const handleAddRule = () => {
        const trimmed = newRule.trim();
        if (!trimmed) return;
        setRules(prev => [...prev, trimmed]);
        setNewRule('');
    };

    const handleEditRule = (index, value) => {
        setRules(prev => {
            const next = [...prev];
            next[index] = value;
            return next;
        });
    };

    const handleRemoveRule = (index) => {
        setRules(prev => prev.filter((_, i) => i !== index));
    };

    const handleAddParagraph = () => {
        const trimmed = newParagraph.trim();
        if (!trimmed) return;
        setReferenceParagraphs(prev => [...prev, trimmed]);
        setNewParagraph('');
    };

    const handleRemoveParagraph = (index) => {
        setReferenceParagraphs(prev => prev.filter((_, i) => i !== index));
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            const payload = {
                rules: rules.map(r => r.trim()).filter(Boolean),
                reference_paragraphs: referenceParagraphs.map(p => p.trim()).filter(Boolean),
                inferred_style: inferredStyle.trim(),
            };
            const saved = await api.saveVoiceProfile(payload);
            setRules(saved.rules || []);
            setReferenceParagraphs(saved.reference_paragraphs || []);
            setInferredStyle(saved.inferred_style || '');
            setSavedSnapshot(JSON.stringify({
                rules: saved.rules || [],
                reference_paragraphs: saved.reference_paragraphs || [],
                inferred_style: saved.inferred_style || '',
            }));
            setSuccess(true);
            setTimeout(() => setSuccess(false), 3000);
        } catch (err) {
            setError('Failed to save voice profile');
        } finally {
            setSaving(false);
        }
    };

    const handleAddRuleKey = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAddRule();
        }
    };

    if (loading) {
        return (
            <section className="settings-section">
                <h3>My Voice</h3>
                <p className="section-description">Loading voice profile...</p>
            </section>
        );
    }

    return (
        <section className="settings-section">
            <h3>My Voice</h3>
            <p className="section-description">
                Your personal writing voice. The Voice Guardian council member and the Chairman
                apply these rules to every essay. The Chairman is explicitly instructed to walk
                through each rule before returning the final draft.
            </p>

            {/* RULES */}
            <div className="subsection" style={{ marginTop: '20px' }}>
                <h4 style={{ margin: '0 0 6px 0' }}>Voice rules</h4>
                <p className="section-description" style={{ marginTop: 0 }}>
                    Short, concrete dos and don'ts. Examples: "Never use em-dashes", "Avoid the
                    word utilize", "Keep sentences under 25 words where possible".
                </p>

                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                    <input
                        type="text"
                        value={newRule}
                        placeholder="e.g. Never use em-dashes"
                        onChange={(e) => setNewRule(e.target.value)}
                        onKeyDown={handleAddRuleKey}
                        style={inputStyle}
                    />
                    <button
                        type="button"
                        onClick={handleAddRule}
                        disabled={!newRule.trim()}
                        style={{
                            ...primaryButtonStyle,
                            opacity: newRule.trim() ? 1 : 0.5,
                            cursor: newRule.trim() ? 'pointer' : 'not-allowed',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        + Add rule
                    </button>
                </div>

                {rules.length === 0 ? (
                    <p className="section-description" style={{ fontStyle: 'italic' }}>
                        No rules yet. The Voice Guardian and Chairman will fall back to the default
                        anti-AI-speak rules until you add some.
                    </p>
                ) : (
                    <div>
                        {rules.map((rule, idx) => (
                            <div
                                key={idx}
                                style={{
                                    ...cardStyle,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                }}
                            >
                                <input
                                    type="text"
                                    value={rule}
                                    onChange={(e) => handleEditRule(idx, e.target.value)}
                                    style={{
                                        ...inputStyle,
                                        background: 'rgba(0,0,0,0.15)',
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => handleRemoveRule(idx)}
                                    style={removeButtonStyle}
                                    title="Remove rule"
                                >
                                    Remove
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* REFERENCE PARAGRAPHS */}
            <div className="subsection" style={{ marginTop: '32px' }}>
                <h4 style={{ margin: '0 0 6px 0' }}>Paragraphs you've written</h4>
                <p className="section-description" style={{ marginTop: 0 }}>
                    Optional. Paste paragraphs you've actually written. Council members will match
                    your cadence, vocabulary, and rhythm — not your topic.
                </p>

                <textarea
                    value={newParagraph}
                    onChange={(e) => setNewParagraph(e.target.value)}
                    placeholder="Paste a paragraph you've written..."
                    rows={5}
                    style={{
                        ...inputStyle,
                        marginBottom: '8px',
                        resize: 'vertical',
                    }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
                    <button
                        type="button"
                        onClick={handleAddParagraph}
                        disabled={!newParagraph.trim()}
                        style={{
                            ...primaryButtonStyle,
                            opacity: newParagraph.trim() ? 1 : 0.5,
                            cursor: newParagraph.trim() ? 'pointer' : 'not-allowed',
                        }}
                    >
                        + Add paragraph
                    </button>
                </div>

                {referenceParagraphs.length === 0 ? (
                    <p className="section-description" style={{ fontStyle: 'italic' }}>
                        No reference paragraphs saved yet.
                    </p>
                ) : (
                    <div>
                        {referenceParagraphs.map((para, idx) => (
                            <div key={idx} style={cardStyle}>
                                <div
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        marginBottom: '8px',
                                    }}
                                >
                                    <strong style={{ fontSize: '12px', opacity: 0.7 }}>
                                        Sample {idx + 1}
                                    </strong>
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveParagraph(idx)}
                                        style={removeButtonStyle}
                                    >
                                        Remove
                                    </button>
                                </div>
                                <p
                                    style={{
                                        margin: 0,
                                        whiteSpace: 'pre-wrap',
                                        fontFamily: 'var(--font-content, serif)',
                                        fontSize: '14px',
                                        lineHeight: 1.5,
                                        color: '#e2e8f0',
                                    }}
                                >
                                    {para}
                                </p>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* INFERRED STYLE (advanced/optional) */}
            <details
                style={{
                    marginTop: '32px',
                    padding: '12px 14px',
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.08)',
                }}
            >
                <summary
                    style={{
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontSize: '13px',
                        opacity: 0.8,
                    }}
                >
                    Inferred style notes (optional)
                </summary>
                <p
                    className="section-description"
                    style={{ marginTop: '8px', marginBottom: '8px' }}
                >
                    Free-form notes about your style. Reserved for future "infer my style"
                    automation; you can write your own notes here for now.
                </p>
                <textarea
                    value={inferredStyle}
                    onChange={(e) => setInferredStyle(e.target.value)}
                    placeholder="e.g. Tends toward dry humor; opens with concrete details rather than abstractions."
                    rows={4}
                    style={{
                        ...inputStyle,
                        resize: 'vertical',
                    }}
                />
            </details>

            {/* SAVE BAR */}
            <div
                style={{
                    marginTop: '24px',
                    paddingTop: '16px',
                    borderTop: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    flexWrap: 'wrap',
                }}
            >
                <div style={{ minHeight: '20px', fontSize: '13px' }}>
                    {error && <span style={{ color: '#f87171' }}>{error}</span>}
                    {success && <span style={{ color: '#4ade80' }}>Voice profile saved.</span>}
                    {!error && !success && isDirty && (
                        <span style={{ color: '#fbbf24', opacity: 0.85 }}>Unsaved changes</span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !isDirty}
                    style={{
                        ...primaryButtonStyle,
                        opacity: saving || !isDirty ? 0.5 : 1,
                        cursor: saving || !isDirty ? 'not-allowed' : 'pointer',
                    }}
                >
                    {saving ? 'Saving...' : 'Save voice profile'}
                </button>
            </div>
        </section>
    );
}
