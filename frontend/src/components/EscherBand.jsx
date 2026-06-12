/**
 * EscherBand — the theme's signature ornament.
 *
 * A horizontal metamorphosis strip in the spirit of Escher's
 * "Metamorphosis II": a square becomes a tumbling block, becomes a
 * hexagon, becomes a coffee bean, sprouts a wing, and flies off as
 * birds. Used as a decorative divider on the login screen and the
 * final-essay plate. Purely presentational (aria-hidden), inherits
 * width from its container.
 */

// Bird silhouette centered on its own origin (~48w × 38h).
// Exported so EscherField (the login backdrop) flies the same bird.
export const BIRD_PATH =
  'M -22 0 L -12 -2 C -8 -8, -4 -16, 4 -18 C 2 -12, 0 -6, -1 -3 ' +
  'C 6 -5, 14 -4, 19 1 L 24 3 L 18 5 C 12 8, 6 8, 0 6 ' +
  'C -2 12, -6 17, -13 19 C -11 13, -10 8, -11 5 L -20 4 Z';

export default function EscherBand({ height = 44, className = '' }) {
  return (
    <svg
      className={`escher-band ${className}`}
      viewBox="0 0 640 64"
      height={height}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <path id="mc-band-bird" d={BIRD_PATH} />
      </defs>

      {/* the transformation axis */}
      <line
        x1="8" y1="32" x2="632" y2="32"
        stroke="#d4913c" strokeOpacity="0.18"
        strokeWidth="1" strokeDasharray="2 5"
      />

      {/* 1 — square (the grid Metamorphosis always starts from) */}
      <rect x="25" y="17" width="30" height="30" fill="#d4913c" fillOpacity="0.3" />

      {/* 2 — the square tilts */}
      <rect
        x="106" y="18" width="28" height="28"
        transform="rotate(45 120 32)"
        fill="#d4913c" fillOpacity="0.42"
      />

      {/* 3 — tumbling block (three-tone isometric cube) */}
      <g>
        <path d="M200 17 L215 24.5 L200 32 L185 24.5 Z" fill="#e8b558" fillOpacity="0.62" />
        <path d="M185 24.5 L200 32 L200 47 L185 39.5 Z" fill="#8d5e34" fillOpacity="0.6" />
        <path d="M215 24.5 L215 39.5 L200 47 L200 32 Z" fill="#5a3a1f" fillOpacity="0.75" />
      </g>

      {/* 4 — the cube flattens into a hexagon */}
      <path
        d="M280 15 L294.7 23.5 L294.7 40.5 L280 49 L265.3 40.5 L265.3 23.5 Z"
        fill="none" stroke="#d4913c" strokeOpacity="0.75" strokeWidth="1.5"
      />

      {/* 5 — the hexagon ripens into a bean */}
      <g transform="rotate(-18 360 32)">
        <ellipse cx="360" cy="32" rx="17" ry="12.5" fill="#a9743f" fillOpacity="0.9" />
        <path
          d="M349 38 Q 357 33 360 32 Q 363 31 371 26"
          fill="none" stroke="#1a130c" strokeWidth="2.4" strokeLinecap="round"
        />
      </g>

      {/* 6 — the bean sprouts a wing */}
      <g>
        <g transform="rotate(-26 440 34)">
          <ellipse cx="440" cy="34" rx="15" ry="11" fill="#c6915a" fillOpacity="0.9" />
          <path
            d="M431 39 Q 438 35 440 34 Q 442 33 449 29"
            fill="none" stroke="#1a130c" strokeWidth="2" strokeLinecap="round"
          />
        </g>
        <path
          d="M434 24 Q 440 8 456 12 Q 447 16 442 25 Z"
          fill="#d4913c" fillOpacity="0.75"
        />
      </g>

      {/* 7 — the bird */}
      <use
        href="#mc-band-bird"
        transform="translate(522 32)"
        fill="#e8b558" fillOpacity="0.92"
      />

      {/* 8 — and away, like steam off the cup */}
      <use
        href="#mc-band-bird"
        transform="translate(592 20) scale(0.55) rotate(-14)"
        fill="#e8b558" fillOpacity="0.65"
      />
      <use
        href="#mc-band-bird"
        transform="translate(616 42) scale(0.38) rotate(-8)"
        fill="#e8b558" fillOpacity="0.42"
      />
    </svg>
  );
}
