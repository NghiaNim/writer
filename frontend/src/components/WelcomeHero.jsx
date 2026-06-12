import MidnightLogo from './MidnightLogo';
import CouncilGrid from './CouncilGrid';
import EscherBand, { BIRD_PATH } from './EscherBand';
import './WelcomeHero.css';

/**
 * WelcomeHero — the frontispiece shown when no conversation is open.
 *
 * Carries the login screen's title-page grammar into the app: a small
 * flock rises off the masthead like steam off the cup (same bird as
 * EscherField), the metamorphosis band sits under the tagline like a
 * printer's ornament, and the council grid is presented beneath it.
 * Used by both empty-state branches in ChatInterface so the two stay
 * identical.
 */
export default function WelcomeHero({ councilModels, chairmanModel, onOpenSettings }) {
    return (
        <div className="welcome-hero">
            <svg
                className="welcome-flock"
                viewBox="0 0 360 130"
                aria-hidden="true"
                focusable="false"
            >
                <g className="wf-bird wf-b1">
                    <path d={BIRD_PATH} transform="translate(168 108) scale(0.6)" />
                </g>
                <g className="wf-bird wf-b2">
                    <path d={BIRD_PATH} transform="translate(218 76) scale(-0.45 0.45) rotate(-12)" />
                </g>
                <g className="wf-bird wf-b3">
                    <path d={BIRD_PATH} transform="translate(142 50) scale(0.33) rotate(9)" />
                </g>
                <g className="wf-bird wf-b4">
                    <path d={BIRD_PATH} transform="translate(232 28) scale(0.23) rotate(-18)" />
                </g>
                <g className="wf-bird wf-b5">
                    <path d={BIRD_PATH} transform="translate(178 12) scale(-0.16 0.16) rotate(6)" />
                </g>
            </svg>

            <h1 className="welcome-title">
                <MidnightLogo size={44} className="midnight-logo--welcome" />
                Welcome to MidnightCoffee
            </h1>

            <p className="welcome-tagline">
                The lamps are lit and the council is seated. Pour something good.
            </p>

            <EscherBand height={34} className="welcome-band" />

            <div className="welcome-grid-container">
                <CouncilGrid models={councilModels} chairman={chairmanModel} status="idle" />
            </div>

            <p className="welcome-hint">
                <span>Start a new essay from the sidebar</span>
                <span className="welcome-hint-sep" aria-hidden="true">·</span>
                <button
                    type="button"
                    className="config-link"
                    onClick={() => onOpenSettings('council')}
                >
                    Configure the council
                </button>
            </p>
        </div>
    );
}
