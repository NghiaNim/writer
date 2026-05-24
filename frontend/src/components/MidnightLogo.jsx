import './MidnightLogo.css';

/**
 * MidnightLogo — the brand mark for MidnightCoffee.
 *
 * Renders the SVG that lives at /midnightcoffee.svg (also wired as the
 * favicon in index.html). The icon is a self-contained chip with its own
 * dark slate background, gold cup, steam, and crescent-moon negative
 * space — designed to read at small sizes without an extra container.
 *
 * Use this anywhere the wordmark "MidnightCoffee" is presented as a
 * title or page identity (sidebar header, login title, welcome screens).
 * For inline body text or bullet glyphs, prefer the CSS-only `.coffee-bean`
 * span — that's a decorative bean, not the brand mark, and shouldn't be
 * conflated.
 *
 * Props:
 *   size  pixel height (and width) of the rendered logo. Default 22 — a
 *         comfortable inline-with-text size for sidebar headers.
 *   className  extra class for spacing/positioning overrides.
 */
export default function MidnightLogo({ size = 22, className = '' }) {
    return (
        <img
            src="/midnightcoffee.svg"
            alt=""
            aria-hidden="true"
            width={size}
            height={size}
            className={`midnight-logo ${className}`.trim()}
            draggable={false}
        />
    );
}
