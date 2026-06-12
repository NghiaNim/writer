import { BIRD_PATH } from './EscherBand';

/**
 * EscherField — the login backdrop.
 *
 * One continuous metamorphosis covering the whole viewport, read
 * bottom-to-top the way Escher's "Metamorphosis II" reads left-to-
 * right: a strict checkerboard loosens into chamfered tiles, the
 * tiles become hexagons, the hexagons ripen into coffee beans
 * (alternating positive/negative, the figure-ground reversal of
 * "Sky and Water I"), the beans sprout wings, and the top rows
 * dissolve into birds drifting up into the lamp glow.
 *
 * Geometry is fully deterministic — every jitter, mirror, and
 * animation delay derives from a cell hash, so the field is stable
 * across renders. Motion is CSS-only (.ef-bird in Login.css) and
 * disabled under prefers-reduced-motion.
 */

const COLS = 10;
const CELL = 80;
const W = COLS * CELL; // 800
const ROWS = 13;
const H = 1060;

const AMBER = '#d4913c';
const CREMA = '#e8b558';
const INK = '#16100a';

// Small deterministic hash for per-cell variation.
const hash = (c, r) => (((c + 13) * 73856093) ^ ((r + 7) * 19349663)) >>> 0;

const hexPoints = (cx, cy, R) => {
  const dx = 0.866 * R;
  const dy = 0.5 * R;
  return [
    [cx, cy - R],
    [cx + dx, cy - dy],
    [cx + dx, cy + dy],
    [cx, cy + R],
    [cx - dx, cy + dy],
    [cx - dx, cy - dy],
  ]
    .map((p) => p.map((n) => Math.round(n * 10) / 10).join(','))
    .join(' ');
};

const chamferPoints = (cx, cy, half, t) => {
  const x0 = cx - half;
  const x1 = cx + half;
  const y0 = cy - half;
  const y1 = cy + half;
  return [
    [x0 + t, y0],
    [x1 - t, y0],
    [x1, y0 + t],
    [x1, y1 - t],
    [x1 - t, y1],
    [x0 + t, y1],
    [x0, y1 - t],
    [x0, y0 + t],
  ]
    .map((p) => p.join(','))
    .join(' ');
};

function Bean({ cx, cy, rx, ry, tilt, dark }) {
  return (
    <g transform={`rotate(${tilt} ${cx} ${cy})`}>
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        fill={dark ? INK : AMBER}
        fillOpacity={dark ? 0.85 : 0.26}
        stroke={AMBER}
        strokeOpacity={dark ? 0.35 : 0.4}
      />
      <path
        d={`M ${cx - rx * 0.62} ${cy + ry * 0.45} Q ${cx - rx * 0.1} ${cy + ry * 0.1} ${cx} ${cy} Q ${cx + rx * 0.1} ${cy - ry * 0.1} ${cx + rx * 0.62} ${cy - ry * 0.45}`}
        fill="none"
        stroke={dark ? AMBER : INK}
        strokeOpacity={dark ? 0.5 : 0.7}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </g>
  );
}

function cellFor(c, r) {
  // r counts from the BOTTOM row (r=0) upward.
  const cx = c * CELL + CELL / 2;
  const cy = H - 30 - r * CELL;
  const h = hash(c, r);
  const even = (c + r) % 2 === 0;
  const key = `${c}-${r}`;

  // Rows 0-1 — the checkerboard. Order before transformation.
  if (r <= 1) {
    return (
      <rect
        key={key}
        x={cx - 37}
        y={cy - 37}
        width={74}
        height={74}
        fill={even ? AMBER : 'none'}
        fillOpacity={even ? 0.1 : 0}
        stroke={AMBER}
        strokeOpacity={0.18}
      />
    );
  }

  // Row 2 — corners begin to give way (chamfered tiles).
  if (r === 2) {
    return (
      <polygon
        key={key}
        points={chamferPoints(cx, cy, 36, 13)}
        fill={even ? AMBER : 'none'}
        fillOpacity={even ? 0.12 : 0}
        stroke={AMBER}
        strokeOpacity={0.22}
      />
    );
  }

  // Row 3 — hexagons. The lattice finds its second nature.
  if (r === 3) {
    return (
      <polygon
        key={key}
        points={hexPoints(cx, cy, 38)}
        fill={even ? AMBER : 'none'}
        fillOpacity={even ? 0.13 : 0}
        stroke={AMBER}
        strokeOpacity={0.26}
      />
    );
  }

  // Row 4 — hexagons soften toward beans: ellipse + proto-crease.
  if (r === 4) {
    return (
      <g key={key}>
        <ellipse
          cx={cx}
          cy={cy}
          rx={33}
          ry={27}
          fill={even ? AMBER : 'none'}
          fillOpacity={even ? 0.16 : 0}
          stroke={AMBER}
          strokeOpacity={0.3}
        />
        <line
          x1={cx - 18}
          y1={cy + 7}
          x2={cx + 18}
          y2={cy - 7}
          stroke={even ? INK : AMBER}
          strokeOpacity={0.45}
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    );
  }

  // Rows 5-6 — beans, alternating positive/negative (Sky and Water).
  if (r === 5 || r === 6) {
    const tilt = even ? -14 : 14;
    return (
      <Bean
        key={key}
        cx={cx}
        cy={cy}
        rx={r === 5 ? 28 : 25}
        ry={r === 5 ? 21 : 18}
        tilt={tilt}
        dark={!even}
      />
    );
  }

  // Row 7 — the beans sprout wings (glide-reflected on odd columns).
  if (r === 7) {
    const mirror = c % 2 === 1;
    return (
      <g
        key={key}
        transform={mirror ? `translate(${2 * cx} 0) scale(-1 1)` : undefined}
      >
        <Bean cx={cx} cy={cy + 4} rx={21} ry={15} tilt={-22} dark={!even} />
        <path
          d={`M ${cx - 6} ${cy - 8} Q ${cx + 2} ${cy - 32} ${cx + 22} ${cy - 27} Q ${cx + 10} ${cy - 18} ${cx + 4} ${cy - 6} Z`}
          fill={AMBER}
          fillOpacity={0.4}
          stroke={AMBER}
          strokeOpacity={0.3}
        />
      </g>
    );
  }

  // Rows 8+ — birds. Sparser, smaller, freer with altitude.
  const sparsity = r - 7; // 1..5
  if (h % (sparsity + 2) !== 0) return null;

  const jx = ((h >> 3) % 49) - 24;
  const jy = ((h >> 7) % 37) - 18;
  const scale = Math.max(0.4, 1.05 - sparsity * 0.13);
  const mirror = (h >> 5) % 2 === 1 ? -1 : 1;
  const rot = (((h >> 9) % 25) - 12) * mirror;
  const opacity = Math.max(0.14, 0.5 - sparsity * 0.07);
  const delay = ((h >> 4) % 80) / 10; // 0–7.9s
  const dur = 9 + ((h >> 6) % 60) / 10; // 9–14.9s

  return (
    <g
      key={key}
      className="ef-bird"
      style={{ animationDelay: `${delay}s`, animationDuration: `${dur}s` }}
    >
      <path
        d={BIRD_PATH}
        transform={`translate(${cx + jx} ${cy + jy}) scale(${scale * mirror} ${scale}) rotate(${rot})`}
        fill={CREMA}
        fillOpacity={opacity}
      />
    </g>
  );
}

export default function EscherField() {
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const el = cellFor(c, r);
      if (el) cells.push(el);
    }
  }

  return (
    <svg
      className="escher-field"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      {cells}
    </svg>
  );
}
