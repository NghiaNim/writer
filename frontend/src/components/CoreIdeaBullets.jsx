import { useEffect, useMemo, useRef, useState } from 'react';
import MicButton from './common/MicButton';
import './CoreIdeaBullets.css';

/**
 * CoreIdeaBullets — cafe-receipt take on the "Your core idea" editor.
 *
 * Reads the LLM-drafted paragraph in `value`, parses it into discrete
 * bullets (sentence-split with a few cleanups), and renders each as its
 * own editable row. The Dictate button is lifted out of the editor and
 * placed in a header toolbar so the text content can never cover it.
 *
 * On every edit (add, remove, type, paste, dictate) we serialize the
 * bullets back into a newline-joined string and call `onChange(serialized)`
 * — the parent's `coreIdea` state always holds the canonical form, so
 * `buildInteractiveMessage` in EssayFlow keeps working unmodified and the
 * council prompt simply receives the bullets as separate lines.
 *
 * Visual personality: warm crema palette to match brewMode, coffee-bean
 * bullet glyph (a tilted radial-gradient oval with a faux crease), and a
 * perforated bottom edge on the card mimicking a receipt tear line.
 */

const MIN_BULLET_LEN = 6;        // shorter than this → noise / artifact, drop
const MAX_BULLETS_FROM_PARSE = 8; // protect against runaway sentence-splits

/** Split a paragraph into bullets. Newlines already act as separators. */
function parseToBullets(text) {
    if (!text || !text.trim()) return [];

    // 1. Hard split on explicit newlines. If the saved value is already
    //    a newline-separated list (most likely once the user has used
    //    this UI), we just keep their split.
    const byLines = text
        .split(/[\n\r]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    if (byLines.length > 1) {
        return byLines.slice(0, MAX_BULLETS_FROM_PARSE);
    }

    // 2. Otherwise sentence-split. The lookahead requires the next
    //    non-space char to be a capital letter so we don't break on
    //    abbreviations like "e.g." or "i.e."
    const raw = byLines[0] || text.trim();
    const sentences = raw
        .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
        .map((s) => s.trim())
        .filter((s) => s.length >= MIN_BULLET_LEN);

    if (sentences.length <= 1) return [raw];

    // 3. Light cleanup: strip leading conjunctions that bridge to a prior
    //    sentence — they read awkwardly in standalone bullet form.
    const STRIP = /^(And|But|So|Or|Yet|Then|Also|Plus)\s+/i;
    return sentences.map((s) => s.replace(STRIP, '')).slice(0, MAX_BULLETS_FROM_PARSE);
}

function serializeBullets(bullets) {
    return bullets
        .map((b) => (b || '').trim())
        .filter(Boolean)
        .join('\n');
}

export default function CoreIdeaBullets({ value, onChange, disabled = false }) {
    // Bullets are derived from `value` only on the FIRST mount. After
    // that they're owned by this component so typing doesn't reset on
    // every parent rerender. Re-parse if the parent fully replaces the
    // value (e.g. the LLM finished drafting and dropped in a paragraph).
    const initial = useMemo(() => parseToBullets(value), []);  // eslint-disable-line react-hooks/exhaustive-deps
    const [bullets, setBullets] = useState(
        initial.length ? initial : ['']
    );
    const lastValueSeenRef = useRef(value);

    useEffect(() => {
        // If the parent's value is a totally different paragraph (LLM
        // finished drafting, or user clicked Back and the brief got
        // regenerated), reparse.
        if (value === lastValueSeenRef.current) return;
        if (value === serializeBullets(bullets)) {
            // Our own write echoed back — no-op.
            lastValueSeenRef.current = value;
            return;
        }
        const next = parseToBullets(value);
        setBullets(next.length ? next : ['']);
        lastValueSeenRef.current = value;
    }, [value, bullets]);

    const writeUp = (next) => {
        setBullets(next);
        const serialized = serializeBullets(next);
        lastValueSeenRef.current = serialized;
        onChange(serialized);
    };

    const handleEdit = (idx, text) => {
        const next = bullets.slice();
        next[idx] = text;
        writeUp(next);
    };

    const handleRemove = (idx) => {
        const next = bullets.filter((_, i) => i !== idx);
        writeUp(next.length ? next : ['']);
    };

    const handleAdd = () => {
        writeUp([...bullets, '']);
    };

    /**
     * Mic appends to the last bullet if it's empty, otherwise creates a
     * new bullet at the end and seeds it with the dictated text. That
     * matches the natural "speak another thought" rhythm without forcing
     * the user to click +Add first.
     *
     * We adapt the MicButton's value/onChange contract: pass it a
     * synthetic "active dictation target" that aliases the trailing
     * bullet.
     */
    const tailIdx = bullets.length - 1;
    const tailValue = bullets[tailIdx] || '';
    const micValue = tailValue;
    const handleMicChange = (next) => {
        // The mic always appends with a separator, so `next` is
        // `tailValue + ' ' + spoken`. We simply replace the tail.
        const updated = bullets.slice();
        updated[tailIdx] = next;
        writeUp(updated);
    };

    return (
        <div className="coreidea-card">
            <div className="coreidea-card-header">
                <div className="coreidea-card-tag">
                    <span className="coreidea-card-tag-dot" aria-hidden="true" />
                    Today's pour
                </div>
                <div className="coreidea-card-mic">
                    <MicButton
                        value={micValue}
                        onChange={handleMicChange}
                        disabled={disabled}
                        size="md"
                        showLabel
                        title="Dictate — adds to the last bullet, or starts a new one if it's empty"
                    />
                </div>
            </div>

            <ul className="coreidea-bullets">
                {bullets.map((b, idx) => (
                    <li className="coreidea-bullet" key={idx}>
                        <span className="coreidea-bullet-bean" aria-hidden="true" />
                        <textarea
                            className="coreidea-bullet-input"
                            value={b}
                            onChange={(e) => handleEdit(idx, e.target.value)}
                            placeholder={
                                idx === 0
                                    ? "What you're actually after, in your own words…"
                                    : 'Another beat of the same idea…'
                            }
                            disabled={disabled}
                            rows={1}
                            onInput={(e) => {
                                // Auto-grow without locking maxHeight — short
                                // bullets stay short, long ones expand.
                                e.target.style.height = 'auto';
                                e.target.style.height = `${e.target.scrollHeight}px`;
                            }}
                        />
                        {bullets.length > 1 && (
                            <button
                                type="button"
                                className="coreidea-bullet-remove"
                                onClick={() => handleRemove(idx)}
                                disabled={disabled}
                                title="Remove this bullet"
                                aria-label="Remove bullet"
                            >
                                ×
                            </button>
                        )}
                    </li>
                ))}
            </ul>

            <div className="coreidea-card-footer">
                <button
                    type="button"
                    className="coreidea-add"
                    onClick={handleAdd}
                    disabled={disabled}
                >
                    + add another bullet
                </button>
                <div className="coreidea-card-count">
                    {bullets.filter((b) => b.trim()).length} bullet
                    {bullets.filter((b) => b.trim()).length === 1 ? '' : 's'}
                </div>
            </div>
        </div>
    );
}
