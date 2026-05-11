import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

const colors = {
    panelBg: 'rgba(15, 23, 42, 0.55)',
    panelBorder: 'rgba(148, 163, 184, 0.18)',
    factBg: 'rgba(59, 130, 246, 0.06)',
    factBorder: 'rgba(59, 130, 246, 0.22)',
    archivedBg: 'rgba(148, 163, 184, 0.04)',
    archivedBorder: 'rgba(148, 163, 184, 0.18)',
    text: '#e2e8f0',
    textMuted: '#94a3b8',
    accent: '#60a5fa',
    danger: '#f87171',
};

const CATEGORY_LABELS = {
    biography: 'Biography',
    experience: 'Experiences',
    belief: 'Beliefs & values',
    interest: 'Interests',
    achievement: 'Achievements',
    relationship: 'Relationships',
    reference: 'Writers / works',
    general: 'Other',
};

// Order in which we render category groups.
const CATEGORY_ORDER = [
    'biography',
    'experience',
    'belief',
    'interest',
    'achievement',
    'relationship',
    'reference',
    'general',
];

/**
 * "What We Know" panel — displays everything the council has accumulated
 * about the user as durable user_fact rows, grouped by category, with
 * inline delete. Folded summary rows (source='summary') are surfaced too,
 * so the user can see how their memory has been compressed.
 */
export default function MemorySettings() {
    const [facts, setFacts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [deleting, setDeleting] = useState(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await api.userFacts.list();
            const list = Array.isArray(res?.facts) ? res.facts : [];
            setFacts(list);
        } catch (e) {
            setError(e.message || 'Failed to load facts');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const handleDelete = async (id) => {
        if (!id) return;
        setDeleting(id);
        try {
            await api.userFacts.delete(id);
            setFacts((prev) => prev.filter((f) => f.id !== id));
        } catch (e) {
            setError(e.message || 'Failed to delete fact');
        } finally {
            setDeleting(null);
        }
    };

    const grouped = useMemo(() => {
        const out = {};
        for (const f of facts) {
            const cat = CATEGORY_ORDER.includes(f.category) ? f.category : 'general';
            (out[cat] = out[cat] || []).push(f);
        }
        return out;
    }, [facts]);

    const totalActive = facts.length;

    return (
        <section className="settings-section" style={{ maxWidth: '720px' }}>
            <h2 className="settings-section-title">What we know about you</h2>
            <p className="section-description">
                These are the durable facts the council has remembered about you, pulled from
                your essays and your answers to questions while we drafted. We inject these
                into every essay prompt so the writing is grounded in your real life. Delete
                anything that's wrong, outdated, or that you'd rather we forget.
            </p>

            <div
                style={{
                    marginTop: '16px',
                    padding: '12px 14px',
                    background: colors.panelBg,
                    border: `1px solid ${colors.panelBorder}`,
                    borderRadius: '10px',
                    color: colors.textMuted,
                    fontSize: '12px',
                    lineHeight: 1.5,
                }}
            >
                {totalActive === 0
                    ? 'No memory yet — start an essay and answer the questions we ask while drafting to begin building your profile.'
                    : `${totalActive} active fact${totalActive === 1 ? '' : 's'} on file. Older facts may be folded into a compact summary when there are too many to fit in a prompt; the originals stay in this list.`}
            </div>

            {error && (
                <div
                    style={{
                        marginTop: '12px',
                        padding: '10px 12px',
                        background: 'rgba(248, 113, 113, 0.08)',
                        border: '1px solid rgba(248, 113, 113, 0.35)',
                        borderRadius: '8px',
                        color: '#fca5a5',
                        fontSize: '13px',
                    }}
                >
                    {error}
                </div>
            )}

            {loading ? (
                <p style={{ color: colors.textMuted, marginTop: '20px' }}>Loading…</p>
            ) : (
                <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {CATEGORY_ORDER.map((cat) => {
                        const items = grouped[cat] || [];
                        if (items.length === 0) return null;
                        return (
                            <div key={cat}>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'baseline',
                                        gap: '10px',
                                        marginBottom: '8px',
                                    }}
                                >
                                    <h3
                                        style={{
                                            fontSize: '13px',
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.12em',
                                            color: colors.accent,
                                            margin: 0,
                                        }}
                                    >
                                        {CATEGORY_LABELS[cat]}
                                    </h3>
                                    <span style={{ fontSize: '11px', color: colors.textMuted }}>
                                        {items.length}
                                    </span>
                                </div>
                                <ul
                                    style={{
                                        listStyle: 'none',
                                        padding: 0,
                                        margin: 0,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '8px',
                                    }}
                                >
                                    {items.map((f) => {
                                        const isSummary = f.source === 'summary';
                                        return (
                                            <li
                                                key={f.id}
                                                style={{
                                                    display: 'flex',
                                                    gap: '10px',
                                                    alignItems: 'flex-start',
                                                    padding: '10px 12px',
                                                    background: isSummary ? colors.archivedBg : colors.factBg,
                                                    border: `1px solid ${
                                                        isSummary ? colors.archivedBorder : colors.factBorder
                                                    }`,
                                                    borderRadius: '10px',
                                                }}
                                            >
                                                <span
                                                    aria-hidden
                                                    style={{
                                                        color: colors.accent,
                                                        fontWeight: 700,
                                                        marginTop: '2px',
                                                    }}
                                                >
                                                    •
                                                </span>
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div
                                                        style={{
                                                            color: colors.text,
                                                            fontSize: '14px',
                                                            lineHeight: 1.5,
                                                            wordBreak: 'break-word',
                                                        }}
                                                    >
                                                        {f.fact_text}
                                                    </div>
                                                    <div
                                                        style={{
                                                            marginTop: '4px',
                                                            color: colors.textMuted,
                                                            fontSize: '11px',
                                                            textTransform: 'uppercase',
                                                            letterSpacing: '0.08em',
                                                        }}
                                                    >
                                                        {isSummary
                                                            ? 'Summary of older facts'
                                                            : `Source: ${f.source}`}
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => handleDelete(f.id)}
                                                    disabled={deleting === f.id}
                                                    style={{
                                                        background: 'transparent',
                                                        color: colors.danger,
                                                        border: `1px solid ${colors.danger}`,
                                                        borderRadius: '6px',
                                                        padding: '4px 10px',
                                                        fontSize: '11px',
                                                        cursor: 'pointer',
                                                        flexShrink: 0,
                                                        opacity: deleting === f.id ? 0.5 : 1,
                                                        textTransform: 'uppercase',
                                                        letterSpacing: '0.05em',
                                                    }}
                                                >
                                                    {deleting === f.id ? '…' : 'Forget'}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
