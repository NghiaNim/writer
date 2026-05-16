import { useCallback } from 'react';
import { useSpeechRecognition } from '../../utils/useSpeechRecognition';
import './MicButton.css';

/**
 * MicButton — append-by-voice control for any controlled text input.
 *
 * Usage:
 *   <MicButton value={input} onChange={setInput} disabled={isLoading} />
 *   <MicButton value={input} onChange={setInput} showLabel /> // with "Dictate" text
 *
 * Behavior:
 *   - Toggle: click to start, click to stop. Brainstorming sessions can
 *     run minutes; push-to-hold would tire the hand.
 *   - Singleton: starting one MicButton automatically stops any other
 *     MicButton that's currently listening — only one engine on the mic
 *     at a time. See useSpeechRecognition.js for the registry.
 *   - Each finalized utterance is appended to `value` with a single
 *     space, so the user keeps any text they typed before pressing mic.
 *   - Interim (still-being-recognized) text shows in a small floating
 *     bubble next to the button so the speaker sees that they're heard.
 *   - If the browser has no Speech API, the button doesn't render at
 *     all — graceful degradation, no broken UI.
 */
export default function MicButton({
    value,
    onChange,
    disabled = false,
    title = 'Dictate (talk to fill this field)',
    size = 'md',
    // When true, the button renders with an inline "Dictate" label next
    // to the icon so users actually notice it. Defaults off for surfaces
    // that need a compact icon-only control (e.g. inside the chat input).
    showLabel = false,
}) {
    const handleFinalText = useCallback(
        (text) => {
            if (!text) return;
            const current = value || '';
            const sep = current && !/\s$/.test(current) ? ' ' : '';
            onChange(current + sep + text);
        },
        [value, onChange],
    );

    const { supported, listening, error, interim, start, stop } = useSpeechRecognition({
        onFinalText: handleFinalText,
    });

    if (!supported) return null;

    const handleClick = () => {
        if (disabled) return;
        if (listening) stop();
        else start();
    };

    return (
        <span className={`mic-button-wrap mic-button-wrap--${size}`}>
            <button
                type="button"
                onClick={handleClick}
                disabled={disabled}
                className={`mic-button mic-button--${size} ${showLabel ? 'mic-button--labeled' : ''} ${listening ? 'mic-button--listening' : ''}`}
                title={listening ? 'Stop dictation' : title}
                aria-pressed={listening}
                aria-label={listening ? 'Stop dictation' : 'Start dictation'}
            >
                <span className="mic-button-icon" aria-hidden="true">
                    {listening ? (
                        <span className="mic-button-pulse">
                            <span className="mic-button-dot" />
                            <span className="mic-button-dot" />
                            <span className="mic-button-dot" />
                        </span>
                    ) : (
                        '🎤'
                    )}
                </span>
                {showLabel && (
                    <span className="mic-button-label">
                        {listening ? 'Listening…' : 'Dictate'}
                    </span>
                )}
            </button>
            {listening && interim ? (
                <span className="mic-button-interim" aria-live="polite">
                    {interim}
                </span>
            ) : null}
            {error ? (
                <span className="mic-button-error" role="alert">
                    {error}
                </span>
            ) : null}
        </span>
    );
}
