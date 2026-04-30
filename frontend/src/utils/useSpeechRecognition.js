import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useSpeechRecognition — thin wrapper around the browser Web Speech API.
 *
 * The browser implementation is event-based and stateful (you cannot
 * re-call `.start()` on a running instance, and Chrome will fire
 * `onerror({error: 'no-speech'})` on long pauses). This hook hides those
 * sharp edges and gives a React-shaped interface:
 *
 *   const { supported, listening, error, interim, start, stop } =
 *     useSpeechRecognition({ onFinalText, lang });
 *
 * `onFinalText(text)` fires every time the engine commits a finalized
 * utterance — the consumer is responsible for appending it to whatever
 * input field it owns. We deliberately do NOT manage transcript state
 * here, so the same hook works for any number of inputs without
 * coordination.
 *
 * `interim` is the still-uncommitted current utterance, suitable for
 * showing live as the user speaks (greyed-out preview).
 *
 * Browser support: Chrome / Edge / Safari (with permission). Firefox
 * has no built-in implementation as of 2026-04. We surface
 * `supported=false` so the caller can hide the UI cleanly.
 */
export function useSpeechRecognition({
    onFinalText,
    lang = 'en-US',
    continuous = true,
    interimResults = true,
} = {}) {
    const [listening, setListening] = useState(false);
    const [interim, setInterim] = useState('');
    const [error, setError] = useState(null);

    const recognitionRef = useRef(null);
    const onFinalTextRef = useRef(onFinalText);
    // Whether the user explicitly asked to stop (vs. the engine ending
    // on its own from silence). Used to auto-restart in continuous mode
    // so long brainstorming sessions don't cut off after a pause.
    const userStoppedRef = useRef(false);
    const supported =
        typeof window !== 'undefined' &&
        Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

    // Keep the latest callback in a ref so we don't have to recreate
    // the engine when the parent re-renders with a new closure.
    useEffect(() => {
        onFinalTextRef.current = onFinalText;
    }, [onFinalText]);

    const ensureRecognition = useCallback(() => {
        if (!supported) return null;
        if (recognitionRef.current) return recognitionRef.current;

        const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new Ctor();
        rec.continuous = continuous;
        rec.interimResults = interimResults;
        rec.lang = lang;
        rec.maxAlternatives = 1;

        rec.onresult = (event) => {
            let interimChunk = '';
            // event.results is a live SpeechRecognitionResultList — index from
            // resultIndex forward to only handle results we haven't seen.
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                const transcript = (result[0]?.transcript || '').trim();
                if (!transcript) continue;
                if (result.isFinal) {
                    if (onFinalTextRef.current) onFinalTextRef.current(transcript);
                } else {
                    interimChunk += (interimChunk ? ' ' : '') + transcript;
                }
            }
            setInterim(interimChunk);
        };

        rec.onerror = (event) => {
            // 'no-speech' fires after long silences; not a real error.
            // 'aborted' fires when we call stop() — not a real error.
            if (event.error === 'no-speech' || event.error === 'aborted') {
                return;
            }
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                setError('Microphone permission denied. Allow access in your browser settings.');
            } else if (event.error === 'audio-capture') {
                setError('No microphone detected. Plug one in and try again.');
            } else if (event.error === 'network') {
                setError('Network error during transcription. Check your connection.');
            } else {
                setError(`Speech recognition error: ${event.error}`);
            }
            setListening(false);
        };

        rec.onend = () => {
            setInterim('');
            // Auto-restart if the user hasn't explicitly stopped — the engine
            // can end itself on long silences even in continuous mode.
            if (!userStoppedRef.current) {
                try {
                    rec.start();
                    return;
                } catch (e) {
                    // Already running, or the engine is in a bad state. Fall
                    // through to the listening=false state below.
                }
            }
            setListening(false);
        };

        recognitionRef.current = rec;
        return rec;
    }, [supported, continuous, interimResults, lang]);

    const start = useCallback(() => {
        if (!supported) {
            setError('Speech recognition is not supported in this browser. Try Chrome, Edge, or Safari.');
            return;
        }
        const rec = ensureRecognition();
        if (!rec) return;
        setError(null);
        userStoppedRef.current = false;
        try {
            rec.start();
            setListening(true);
        } catch (e) {
            // Calling start() while already running throws InvalidStateError —
            // treat it as a no-op since we're already in the desired state.
            setListening(true);
        }
    }, [supported, ensureRecognition]);

    const stop = useCallback(() => {
        userStoppedRef.current = true;
        const rec = recognitionRef.current;
        if (!rec) {
            setListening(false);
            return;
        }
        try {
            rec.stop();
        } catch (e) {
            // Already stopped — fine.
        }
        setListening(false);
        setInterim('');
    }, []);

    // Clean up when the consumer unmounts mid-session.
    useEffect(() => {
        return () => {
            userStoppedRef.current = true;
            const rec = recognitionRef.current;
            if (rec) {
                try {
                    rec.onresult = null;
                    rec.onerror = null;
                    rec.onend = null;
                    rec.abort();
                } catch (e) {
                    // ignore
                }
            }
            recognitionRef.current = null;
        };
    }, []);

    return { supported, listening, error, interim, start, stop };
}
